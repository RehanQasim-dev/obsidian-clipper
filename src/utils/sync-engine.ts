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
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

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

function emptyTombstones(): Tombstones {
	return { highlights: {}, drawings: {}, comments: {}, videoItems: {} };
}

// --- Comment marker parsing (no DOM; mirrors comment-overlays.parseNoteString) -

function commentId(note: string): string {
	const m = note.match(/<!--timestamp:(\d+)-->/);
	return m ? m[1] : note; // fall back to raw text as id for legacy notes
}
function commentVersion(note: string): number {
	const ed = note.match(/<!--edited:(\d+)-->/);
	if (ed) return parseInt(ed[1], 10);
	const ts = note.match(/<!--timestamp:(\d+)-->/);
	return ts ? parseInt(ts[1], 10) : 0;
}

// --- Generic keyed 3-way merge -----------------------------------------------

interface MergeResult<T> {
	kept: Map<string, T>;
	tombs: Record<string, number>;
}

function mergeKeyed<T>(
	base: Map<string, T>,
	local: Map<string, T>,
	remote: Map<string, T>,
	inTombs: Record<string, number>,
	versionOf: (t: T) => number,
	combine: (l: T, r: T) => T,
	now: number,
): MergeResult<T> {
	const kept = new Map<string, T>();
	const tombs: Record<string, number> = { ...inTombs };
	const ids = new Set<string>([
		...base.keys(),
		...local.keys(),
		...remote.keys(),
		...Object.keys(inTombs),
	]);

	for (const id of ids) {
		const b = base.get(id);
		const l = local.get(id);
		const r = remote.get(id);
		const tomb = tombs[id];

		if (l && r) {
			// Present on both sides — pick the newer, merging where combine does so.
			const merged = combine(l, r);
			if (tomb !== undefined && versionOf(merged) <= tomb) {
				// Deleted more recently than this edit — stays deleted.
			} else {
				kept.set(id, merged);
				delete tombs[id];
			}
		} else if (l && !r) {
			if (tomb !== undefined) {
				if (versionOf(l) > tomb) {
					kept.set(id, l); // re-edited locally after a remote delete → resurrect
					delete tombs[id];
				}
				// else: respect the tombstone
			} else if (!b) {
				kept.set(id, l); // brand-new local entity
			} else {
				// Was in base, gone from remote, no tombstone → remote deleted it.
				tombs[id] = now;
			}
		} else if (r && !l) {
			if (b) {
				// Was in base, gone locally → local deleted it. Record/refresh tombstone.
				tombs[id] = now;
			} else if (tomb !== undefined) {
				if (versionOf(r) > tomb) {
					kept.set(id, r); // re-added remotely after a delete → resurrect
					delete tombs[id];
				}
			} else {
				kept.set(id, r); // brand-new remote entity
			}
		}
		// else: absent both sides — leave any tombstone for GC below.
	}

	// GC old tombstones so the file doesn't grow forever.
	for (const id of Object.keys(tombs)) {
		if (now - tombs[id] > TOMBSTONE_RETENTION_MS) delete tombs[id];
	}

	return { kept, tombs };
}

function byId<T extends { id: string }>(arr: T[] | undefined): Map<string, T> {
	const m = new Map<string, T>();
	for (const e of arr || []) m.set(e.id, e);
	return m;
}

// --- Comment (notes[]) merge -------------------------------------------------

function mergeNotes(
	baseNotes: string[] | undefined,
	localNotes: string[] | undefined,
	remoteNotes: string[] | undefined,
	commentTombs: Record<string, number>,
	highlightId: string,
	now: number,
): string[] {
	const toMap = (notes: string[] | undefined) => {
		const m = new Map<string, string>();
		for (const n of notes || []) m.set(commentId(n), n);
		return m;
	};
	const base = toMap(baseNotes);
	const local = toMap(localNotes);
	const remote = toMap(remoteNotes);

	// Scope the global comment tombstone map to this highlight.
	const scoped: Record<string, number> = {};
	const prefix = `${highlightId}:`;
	for (const k of Object.keys(commentTombs)) {
		if (k.startsWith(prefix)) scoped[k.slice(prefix.length)] = commentTombs[k];
	}

	const { kept, tombs } = mergeKeyed<string>(
		base,
		local,
		remote,
		scoped,
		commentVersion,
		// Same comment edited on both sides → keep the most recent edit.
		(l, r) => (commentVersion(l) >= commentVersion(r) ? l : r),
		now,
	);

	// Write scoped comment tombstones back into the global map.
	for (const k of Object.keys(scoped)) delete commentTombs[prefix + k];
	for (const k of Object.keys(tombs)) commentTombs[prefix + k] = tombs[k];

	// Preserve a stable order: by creation timestamp (the comment id).
	return [...kept.values()].sort((a, b) => parseInt(commentId(a)) - parseInt(commentId(b)));
}

// --- Highlight & drawing merge ----------------------------------------------

function highlightVersion(h: Highlight): number {
	return h.updatedAt || parseInt(h.id, 10) || 0;
}

function mergeHighlightsStorage(
	base: HighlightsStorage,
	local: HighlightsStorage,
	remote: HighlightsStorage,
	tombs: Tombstones,
	now: number,
): HighlightsStorage {
	const out: HighlightsStorage = {};
	const urls = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

	for (const url of urls) {
		const bMap = byId(base[url]?.highlights);
		const lMap = byId(local[url]?.highlights);
		const rMap = byId(remote[url]?.highlights);

		const combine = (l: Highlight, r: Highlight): Highlight => {
			const newer = highlightVersion(l) >= highlightVersion(r) ? l : r;
			const notes = mergeNotes(
				bMap.get(l.id)?.notes,
				l.notes,
				r.notes,
				tombs.comments,
				l.id,
				now,
			);
			return { ...newer, notes };
		};

		const { kept, tombs: hlTombs } = mergeKeyed(
			bMap,
			lMap,
			rMap,
			tombs.highlights,
			highlightVersion,
			combine,
			now,
		);
		tombs.highlights = hlTombs;

		if (kept.size > 0) {
			const title = local[url]?.title ?? remote[url]?.title ?? base[url]?.title;
			out[url] = {
				url,
				...(title ? { title } : {}),
				highlights: [...kept.values()],
			};
		}
	}
	return out;
}

function mergeDrawingsStorage(
	base: DrawingsStorage,
	local: DrawingsStorage,
	remote: DrawingsStorage,
	tombs: Tombstones,
	now: number,
): DrawingsStorage {
	const out: DrawingsStorage = {};
	const urls = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

	for (const url of urls) {
		const { kept, tombs: strokeTombs } = mergeKeyed(
			byId(base[url]?.strokes),
			byId(local[url]?.strokes),
			byId(remote[url]?.strokes),
			tombs.drawings,
			(s: Stroke) => s.updatedAt || 0,
			(l, r) => ((l.updatedAt || 0) >= (r.updatedAt || 0) ? l : r),
			now,
		);
		tombs.drawings = strokeTombs;
		if (kept.size > 0) {
			out[url] = { url, strokes: [...kept.values()] };
		}
	}
	return out;
}

// --- Video annotation merge --------------------------------------------------

function videoItemVersion(it: VideoItem): number {
	return it.updatedAt || parseInt(it.id, 10) || 0;
}

function mergeVideoStorage(
	base: VideoStorage,
	local: VideoStorage,
	remote: VideoStorage,
	tombs: Tombstones,
	now: number,
): VideoStorage {
	const out: VideoStorage = {};
	const urls = new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)]);

	for (const url of urls) {
		const bMap = byId(base[url]?.items);
		const lMap = byId(local[url]?.items);
		const rMap = byId(remote[url]?.items);

		const combine = (l: VideoItem, r: VideoItem): VideoItem => {
			const newer = videoItemVersion(l) >= videoItemVersion(r) ? l : r;
			const notes = mergeNotes(bMap.get(l.id)?.notes, l.notes, r.notes, tombs.comments, l.id, now);
			// Keep whichever side carries a frame blob id, so a frame uploaded on one
			// device isn't lost when the other device (which only has metadata) wins on time.
			const frame = newer.frame || l.frame || r.frame;
			return { ...newer, notes, ...(frame ? { frame } : {}) };
		};

		const { kept, tombs: itTombs } = mergeKeyed(
			bMap,
			lMap,
			rMap,
			tombs.videoItems,
			videoItemVersion,
			combine,
			now,
		);
		tombs.videoItems = itTombs;

		if (kept.size > 0) {
			const videoId = local[url]?.videoId ?? remote[url]?.videoId ?? base[url]?.videoId;
			const title = local[url]?.title ?? remote[url]?.title ?? base[url]?.title;
			out[url] = {
				url,
				...(videoId ? { videoId } : {}),
				...(title ? { title } : {}),
				items: [...kept.values()],
			};
		}
	}
	return out;
}

// Strip local-only frame image data so it never enters the merge/upload payload.
function stripFrames(store: VideoStorage): VideoStorage {
	const out: VideoStorage = {};
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

		// Load remote (or start a fresh file).
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

		const mergedHighlights = mergeHighlightsStorage(
			snapshot.highlights,
			local.highlights,
			remote.highlights,
			tombs,
			now,
		);
		const mergedDrawings = mergeDrawingsStorage(
			snapshot.drawings,
			local.drawings,
			remote.drawings,
			tombs,
			now,
		);
		// Merge on frame-image-free copies so JPEG data never enters the payload.
		const mergedVideo = mergeVideoStorage(
			stripFrames(snapshot.videoAnnotations),
			stripFrames(localVideo),
			stripFrames(remote.videoAnnotations),
			tombs,
			now,
		);

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

		// Upload only if the merged file differs from what's on Drive.
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
		} else if (mergedJson !== remoteJson) {
			await updateSyncFile(fileMeta.id, mergedJson, interactive);
		}

		await setStatus({ connected: true, syncing: false, lastSyncedAt: now, lastError: undefined });
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
