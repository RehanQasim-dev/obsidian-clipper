import browser from './browser-polyfill';
import {
	isConfigured,
	isConnected,
	findSyncFile,
	downloadSyncFile,
	createSyncFile,
	updateSyncFile,
	createBinaryFile,
	downloadBinaryFile,
} from './google-drive';
// The 3-way merge logic is shared verbatim with the Obsidian plugin so both
// reconcile clipper-sync.json identically. Types stay declared locally (they are
// structurally identical to shared/merge's) to avoid touching the orchestrator.
import {
	emptyTombstones,
	mergeHighlightsStorage,
	mergeDrawingsStorage,
	mergeVideoStorage,
} from '../../shared/merge';

// Three-way sync of annotation data to a single JSON file in Google Drive's
// appDataFolder. Runs in the background service worker.
//
// Data synced (all keyed by normalized URL, mirroring chrome.storage.local):
//   - `highlights`: Record<url, { url, title?, highlights: Highlight[] }>
//                   (comments live inline in each highlight's notes[])
//   - `drawings`:   Record<url, { url, strokes: Stroke[] }>
//
// Reconciliation is a 3-way merge between:
//   base   = `sync_snapshot` (the state we last reconciled, in storage.local)
//   local  = current storage.local
//   remote = the Drive file
// Deletions are detected against `base` and recorded as tombstones in the Drive
// file so a delete on one device isn't resurrected by another. Conflicts on the
// same entity are resolved by most-recent edit (updatedAt for highlights/strokes,
// edited|timestamp for comments).

const SNAPSHOT_KEY = 'sync_snapshot';
const STATUS_KEY = 'sync_status';

// --- Types (structurally compatible with the live storage shapes) ------------

interface Highlight {
	id: string;
	notes?: string[];
	updatedAt?: number;
	[k: string]: unknown;
}
interface StoredHighlights {
	url: string;
	title?: string;
	highlights: Highlight[];
}
interface Stroke {
	id: string;
	updatedAt?: number;
	[k: string]: unknown;
}
interface StoredDrawings {
	url: string;
	strokes: Stroke[];
}
// Video annotations. Items carry the same `id`/`updatedAt`/`notes[]` shape as
// highlights, so they reuse the generic keyed merge + comment merge. A frame
// item's image is NOT carried here — `frame.driveId` references a separate Drive
// blob (see google-drive.createBinaryFile); `frame.dataUrl` is local-only.
interface VideoFrame {
	dataUrl?: string; // local-only; stripped before the item is synced/merged
	driveId?: string; // Drive blob id for the frame image
	[k: string]: unknown;
}
interface VideoItem {
	id: string;
	notes?: string[];
	updatedAt?: number;
	frame?: VideoFrame;
	[k: string]: unknown;
}
interface StoredVideo {
	url: string;
	videoId?: string;
	title?: string;
	items: VideoItem[];
}
type HighlightsStorage = Record<string, StoredHighlights>;
type DrawingsStorage = Record<string, StoredDrawings>;
type VideoStorage = Record<string, StoredVideo>;

interface Tombstones {
	highlights: Record<string, number>; // highlightId -> deletedAt
	drawings: Record<string, number>; // strokeId -> deletedAt
	comments: Record<string, number>; // `${highlightId}:${commentTs}` -> deletedAt
	videoItems: Record<string, number>; // videoItemId -> deletedAt
}

interface SyncFile {
	version: 1;
	highlights: HighlightsStorage;
	drawings: DrawingsStorage;
	videoAnnotations: VideoStorage;
	tombstones: Tombstones;
}

interface Snapshot {
	highlights: HighlightsStorage;
	drawings: DrawingsStorage;
	videoAnnotations: VideoStorage;
}

export interface SyncStatus {
	connected: boolean;
	lastSyncedAt?: number;
	lastError?: string;
	syncing?: boolean;
}

// Strip local-only frame image data so it never enters the merge/upload payload.
function stripFrames(store: VideoStorage | undefined): VideoStorage {
	const out: VideoStorage = {};
	if (!store) return out;
	for (const url of Object.keys(store)) {
		out[url] = {
			...store[url],
			items: (store[url].items || []).map((it) => {
				if (!it.frame) return it;
				const { dataUrl, ...frameRest } = it.frame;
				return { ...it, frame: frameRest };
			}),
		};
	}
	return out;
}

// --- Status helpers ----------------------------------------------------------

async function setStatus(patch: Partial<SyncStatus>): Promise<void> {
	const cur = ((await browser.storage.local.get(STATUS_KEY))[STATUS_KEY] as SyncStatus) || {
		connected: false,
	};
	await browser.storage.local.set({ [STATUS_KEY]: { ...cur, ...patch } });
}

export async function getStatus(): Promise<SyncStatus> {
	const stored = (await browser.storage.local.get(STATUS_KEY))[STATUS_KEY] as SyncStatus | undefined;
	return { connected: await isConnected(), ...(stored || {}) };
}

// --- Reconcile (the single sync operation) -----------------------------------

let running: Promise<void> | null = null;

/**
 * Download remote, 3-way merge with local + snapshot, then write the merged
 * result back to local storage (only if changed) and upload it to Drive (only if
 * changed). Idempotent: re-running with no edits is a no-op, which prevents the
 * local write from looping back into another sync.
 *
 * @param interactive allow an OAuth consent window (manual "Sync now"/Connect).
 */
export async function sync(interactive = false): Promise<void> {
	if (!isConfigured()) {
		if (interactive) throw new Error('Google client id not configured');
		return;
	}
	// Coalesce concurrent calls (debounced push + alarm could overlap).
	if (running) return running;
	running = doSync(interactive).finally(() => {
		running = null;
	});
	return running;
}

async function doSync(interactive: boolean): Promise<void> {
	await setStatus({ syncing: true, lastError: undefined });
	try {
		// The whole reconcile is a read-modify-write over storage.local, but the
		// modify step does seconds of network I/O. An annotation/comment saved by a
		// content script during that window would otherwise be clobbered when we
		// write the (stale) merge back. Guard with a compare-and-swap on local
		// storage: if the source data changed under us, redo the reconcile with the
		// fresh data instead of overwriting it. Bounded so a busy editor still
		// terminates (the regular triggers will pick up any straggler edits).
		for (let pass = 0; ; pass++) {
		const now = Date.now();

		const localStore = await browser.storage.local.get([
			'highlights',
			'drawings',
			'video_annotations',
			SNAPSHOT_KEY,
		]);
		const localVideo = (localStore.video_annotations as VideoStorage) || {};
		const local: Snapshot = {
			highlights: (localStore.highlights as HighlightsStorage) || {},
			drawings: (localStore.drawings as DrawingsStorage) || {},
			videoAnnotations: localVideo,
		};
		// Snapshot the exact source bytes we are about to reconcile, so we can
		// detect a concurrent edit before committing the result below.
		const localDataJson = JSON.stringify({
			highlights: localStore.highlights ?? null,
			drawings: localStore.drawings ?? null,
			video_annotations: localStore.video_annotations ?? null,
		});
		const snapshot: Snapshot = (localStore[SNAPSHOT_KEY] as Snapshot) || {
			highlights: {},
			drawings: {},
			videoAnnotations: {},
		};

		// Upload any local frame image that doesn't yet have a Drive blob, stamping
		// its `driveId` back into local storage. Also index every local image by item
		// id so we can re-attach it after the merge without re-downloading.
		const localImages = new Map<string, string>();
		let uploadedNewBlob = false;
		for (const url of Object.keys(localVideo)) {
			for (const item of localVideo[url].items || []) {
				const f = item.frame;
				if (!f || !f.dataUrl) continue;
				localImages.set(item.id, f.dataUrl);
				if (!f.driveId) {
					try {
						const meta = await createBinaryFile(
							`frame-${item.id}.jpg`,
							f.dataUrl.split(',')[1] || '',
							'image/jpeg',
							interactive,
						);
						f.driveId = meta.id;
						uploadedNewBlob = true;
					} catch {
						// Leave dataUrl-only; a later sync retries the upload.
					}
				}
			}
		}

		// Reconcile against Drive with compare-and-swap: load remote, 3-way merge,
		// and upload ONLY if the remote revision hasn't moved since we downloaded
		// it; if another client wrote in between, re-download and re-merge. This
		// prevents one client's push from silently clobbering another's edits.
		let mergedHighlights: HighlightsStorage = {};
		let mergedDrawings: DrawingsStorage = {};
		let mergedVideo: VideoStorage = {};
		for (let attempt = 0; ; attempt++) {
			const fileMeta = await findSyncFile(interactive);
			let remote: SyncFile = {
				version: 1,
				highlights: {},
				drawings: {},
				videoAnnotations: {},
				tombstones: emptyTombstones(),
			};
			if (fileMeta) {
				try {
					const parsed = JSON.parse(await downloadSyncFile(fileMeta.id, interactive));
					remote = {
						version: 1,
						highlights: parsed.highlights || {},
						drawings: parsed.drawings || {},
						videoAnnotations: parsed.videoAnnotations || {},
						tombstones: { ...emptyTombstones(), ...(parsed.tombstones || {}) },
					};
				} catch {
					// Corrupt remote — treat as empty; this reconcile will rewrite it.
				}
			}

			const tombs: Tombstones = {
				highlights: { ...remote.tombstones.highlights },
				drawings: { ...remote.tombstones.drawings },
				comments: { ...remote.tombstones.comments },
				videoItems: { ...remote.tombstones.videoItems },
			};

			mergedHighlights = mergeHighlightsStorage(snapshot.highlights, local.highlights, remote.highlights, tombs, now);
			mergedDrawings = mergeDrawingsStorage(snapshot.drawings, local.drawings, remote.drawings, tombs, now);
			// Merge on frame-image-free copies so JPEG data never enters the payload.
			mergedVideo = mergeVideoStorage(
				stripFrames(snapshot.videoAnnotations),
				stripFrames(localVideo),
				stripFrames(remote.videoAnnotations),
				tombs,
				now,
			);

			const mergedFile: SyncFile = {
				version: 1,
				highlights: mergedHighlights,
				drawings: mergedDrawings,
				videoAnnotations: mergedVideo,
				tombstones: tombs,
			};
			const mergedJson = JSON.stringify(mergedFile);
			const remoteJson = JSON.stringify({
				version: 1,
				highlights: remote.highlights,
				drawings: remote.drawings,
				videoAnnotations: remote.videoAnnotations,
				tombstones: remote.tombstones,
			});

			if (!fileMeta) {
				await createSyncFile(mergedJson, interactive);
				break;
			}
			if (mergedJson === remoteJson) break; // nothing to upload
			// CAS guard: bail to a retry if the remote moved since our download.
			const fresh = await findSyncFile(interactive);
			if (fresh && fresh.headRevisionId !== fileMeta.headRevisionId && attempt < 3) continue;
			await updateSyncFile(fileMeta.id, mergedJson, interactive);
			break;
		}

		// Re-attach frame images for local storage: prefer the image we already had,
		// otherwise lazily download the blob referenced by a remote-originated frame.
		const mergedVideoLocal: VideoStorage = {};
		for (const url of Object.keys(mergedVideo)) {
			const items: VideoItem[] = [];
			for (const it of mergedVideo[url].items) {
				const f = it.frame;
				if (f && f.driveId) {
					let dataUrl = localImages.get(it.id);
					if (!dataUrl) {
						try {
							dataUrl = await downloadBinaryFile(f.driveId, interactive);
						} catch {
							/* image temporarily unavailable — keep metadata, fetch next sync */
						}
					}
					items.push(dataUrl ? { ...it, frame: { ...f, dataUrl } } : it);
				} else {
					items.push(it);
				}
			}
			mergedVideoLocal[url] = { ...mergedVideo[url], items };
		}

		// Compare-and-swap guard: if a content script wrote new annotation data
		// while we were reconciling over the network, our merge is stale — writing
		// it back would clobber that edit. Re-read and, if the source changed, redo
		// the reconcile (which now sees the new data) instead of committing.
		const fresh = await browser.storage.local.get(['highlights', 'drawings', 'video_annotations']);
		const freshDataJson = JSON.stringify({
			highlights: fresh.highlights ?? null,
			drawings: fresh.drawings ?? null,
			video_annotations: fresh.video_annotations ?? null,
		});
		if (freshDataJson !== localDataJson && pass < 5) {
			continue; // concurrent local edit — reconcile again with the fresh data
		}

		// Apply to local storage only if something actually changed, so the
		// resulting storage.onChanged doesn't trigger an endless sync loop.
		const localWrite: Record<string, unknown> = {};
		if (JSON.stringify(mergedHighlights) !== JSON.stringify(local.highlights)) {
			localWrite.highlights = mergedHighlights;
		}
		if (JSON.stringify(mergedDrawings) !== JSON.stringify(local.drawings)) {
			localWrite.drawings = mergedDrawings;
		}
		if (uploadedNewBlob || JSON.stringify(mergedVideoLocal) !== JSON.stringify(localVideo)) {
			localWrite.video_annotations = mergedVideoLocal;
		}
		const newSnapshot: Snapshot = {
			highlights: mergedHighlights,
			drawings: mergedDrawings,
			videoAnnotations: mergedVideo,
		};
		localWrite[SNAPSHOT_KEY] = newSnapshot;
		await browser.storage.local.set(localWrite);

		await setStatus({ connected: true, syncing: false, lastSyncedAt: now, lastError: undefined });
		break;
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await setStatus({ syncing: false, lastError: message });
		throw err;
	}
}

/** Clear local sync bookkeeping (called on disconnect). */
export async function resetSyncState(): Promise<void> {
	await browser.storage.local.remove([SNAPSHOT_KEY, STATUS_KEY]);
}
