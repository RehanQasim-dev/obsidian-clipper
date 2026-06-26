import browser from './browser-polyfill';
import {
	isConfigured,
	isConnected,
	listFolder,
	findInFolder,
	createTextFile,
	updateTextFile,
	downloadDriveFile,
	uploadBlob,
	updateBlob,
	downloadBlob,
	deleteDriveFile,
	type DriveFileMeta,
} from './google-drive';
import {
	loadFrameImage, saveFrameImage, hasFrameImage,
	loadDiagramImage, saveDiagramImage, hasDiagramImage, deleteDiagramImage,
} from './video/frame-store';
import { getPage, setPage, removePage, getAll, getAllUrls } from './page-store';
// The 3-way merge logic is shared verbatim with the Obsidian plugin. The per-page
// reconcile uses `mergePageRecord` (one page at a time); types come from shared.
import {
	mergePageRecord,
	emptyPageRecord,
	pageFileName,
	type PageRecord,
	type PageDiagram,
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

const STATUS_KEY = 'sync_status';
const DIAGRAMS_KEY = 'diagrams';

// Per-page sync bookkeeping in storage.local:
//   snap:<url>     — the last-reconciled PageRecord (3-way merge base)
//   pagemeta:<url> — { fileId, headRevisionId } of the page's Drive file (CAS + change detect)
const snapKey = (url: string) => `snap:${url}`;
const pageMetaKey = (url: string) => `pagemeta:${url}`;

interface PageMeta { fileId: string; headRevisionId?: string }

// --- Local storage shapes (per-page; structurally compatible) ----------------

interface StoredHighlights { url: string; title?: string; highlights: { id: string; notes?: string[]; updatedAt?: number; [k: string]: unknown }[] }
interface StoredDrawings { url: string; strokes: { id: string; updatedAt?: number; [k: string]: unknown }[] }
interface VideoFrame { dataUrl?: string; driveId?: string; [k: string]: unknown }
interface VideoItem { id: string; notes?: string[]; updatedAt?: number; frame?: VideoFrame; [k: string]: unknown }
interface StoredVideo { url: string; videoId?: string; title?: string; items: VideoItem[] }
interface DiagramEntry { sceneData?: unknown; updatedAt?: number; driveId?: string; sceneDriveId?: string }
type DiagramsMap = Record<string, DiagramEntry>;

export interface SyncStatus {
	connected: boolean;
	lastSyncedAt?: number;
	lastError?: string;
	syncing?: boolean;
}

// --- Page <-> local storage assembly -----------------------------------------

// Page record filename comes from shared/ so the extension + plugin agree on it.
const frameFileName = (id: string) => `frame-${id}.jpg`;
const diagramFileName = (id: string) => `diagram-${id}.png`;

// Diagram ids referenced by a page's highlight comments (`<!--diagram:id-->`).
function collectDiagramIds(highlights: StoredHighlights['highlights']): string[] {
	const ids = new Set<string>();
	for (const h of highlights || []) {
		for (const note of h.notes || []) {
			const m = note.match(/<!--diagram:([A-Za-z0-9_-]+)-->/);
			if (m) ids.add(m[1]);
		}
	}
	return [...ids];
}

// Build the canonical PageRecord for `url` from the sharded local stores. Frame
// image bytes are stripped (only `frame.driveId` is kept); diagram records carry
// `sceneData` + id (+ driveId) but never the PNG.
async function assembleLocalPage(url: string, diagrams: DiagramsMap): Promise<PageRecord> {
	const rec = emptyPageRecord(url);
	const hl = await getPage<StoredHighlights>('hl', url);
	const dr = await getPage<StoredDrawings>('dr', url);
	const va = await getPage<StoredVideo>('va', url);
	if (hl) { rec.highlights = hl.highlights || []; if (hl.title) rec.title = hl.title; }
	if (dr) rec.drawings = dr.strokes || [];
	if (va) {
		rec.videoItems = (va.items || []).map((it) => {
			if (!it.frame) return it;
			const { dataUrl, ...frameRest } = it.frame;
			return { ...it, frame: frameRest };
		});
		if (va.videoId) rec.videoId = va.videoId;
		if (!rec.title && va.title) rec.title = va.title;
	}
	// Pointers only — the scene + PNG bytes travel as separate Drive files/blobs.
	rec.diagrams = collectDiagramIds(rec.highlights)
		.map((id): PageDiagram | null => {
			const d = diagrams[id];
			return d ? {
				id,
				updatedAt: d.updatedAt,
				...(d.driveId ? { driveId: d.driveId } : {}),
				...(d.sceneDriveId ? { sceneDriveId: d.sceneDriveId } : {}),
			} : null;
		})
		.filter((d): d is PageDiagram => d !== null);
	return rec;
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

// --- Diagrams map + image blob helpers ---------------------------------------

async function loadDiagrams(): Promise<DiagramsMap> {
	return ((await browser.storage.local.get(DIAGRAMS_KEY))[DIAGRAMS_KEY] as DiagramsMap) || {};
}

const b64 = (dataUrl: string) => dataUrl.split(',')[1] || '';

// Push this page's local image bytes to Drive, stamping the resulting blob ids
// into the in-memory record so the merged record (and thus the uploaded page JSON
// + local snapshot) carries the pointers. No image bytes ever enter the JSON.
async function pushImages(local: PageRecord, base: PageRecord | null, diagrams: DiagramsMap, interactive: boolean): Promise<void> {
	// Frames are immutable once captured: upload only if it has no Drive blob yet.
	for (const it of local.videoItems) {
		const f = it.frame;
		if (!f || f.driveId) continue;
		const dataUrl = await loadFrameImage(it.id);
		if (!dataUrl) continue; // image not on this device
		try {
			const meta = await uploadBlob('frames', frameFileName(it.id), b64(dataUrl), 'image/jpeg', interactive);
			f.driveId = meta.id;
		} catch { /* retry next sync */ }
	}
	// Diagrams are editable: (re)upload PNG + scene when newer than the base.
	const baseById = new Map((base?.diagrams || []).map((d) => [d.id, d]));
	for (const d of local.diagrams) {
		const baseD = baseById.get(d.id);
		const edited = !baseD || (d.updatedAt || 0) > (baseD.updatedAt || 0);
		const entry = diagrams[d.id];
		if (!d.driveId || edited) {
			const dataUrl = await loadDiagramImage(d.id);
			if (dataUrl) {
				try {
					const meta = d.driveId
						? await updateBlob(d.driveId, b64(dataUrl), 'image/png', interactive)
						: await uploadBlob('diagrams', diagramFileName(d.id), b64(dataUrl), 'image/png', interactive);
					d.driveId = meta.id;
				} catch { /* retry next sync */ }
			}
		}
		if ((!d.sceneDriveId || edited) && entry?.sceneData !== undefined) {
			const sceneJson = JSON.stringify(entry.sceneData);
			try {
				const meta = d.sceneDriveId
					? await updateTextFile(d.sceneDriveId, sceneJson, interactive)
					: await createTextFile('diagrams', `diagram-${d.id}.scene.json`, sceneJson, interactive);
				d.sceneDriveId = meta.id;
			} catch { /* retry next sync */ }
		}
	}
}

// Download any image/scene this device is missing for the merged page.
async function pullImages(merged: PageRecord, diagrams: DiagramsMap, interactive: boolean): Promise<boolean> {
	let diagramsChanged = false;
	for (const it of merged.videoItems) {
		const f = it.frame;
		if (f?.driveId && !(await hasFrameImage(it.id))) {
			try {
				const dataUrl = await downloadBlob(f.driveId, interactive);
				if (dataUrl) await saveFrameImage(it.id, dataUrl);
			} catch { /* fetch next sync */ }
		}
	}
	for (const d of merged.diagrams) {
		if (d.driveId && !(await hasDiagramImage(d.id))) {
			try {
				const dataUrl = await downloadBlob(d.driveId, interactive);
				if (dataUrl) await saveDiagramImage(d.id, dataUrl);
			} catch { /* fetch next sync */ }
		}
		const entry = diagrams[d.id];
		const needScene = d.sceneDriveId && (!entry || (entry.updatedAt || 0) < (d.updatedAt || 0));
		if (needScene) {
			try {
				const sceneData = JSON.parse(await downloadDriveFile(d.sceneDriveId!, interactive));
				diagrams[d.id] = { sceneData, updatedAt: d.updatedAt, driveId: d.driveId, sceneDriveId: d.sceneDriveId };
				diagramsChanged = true;
			} catch { /* fetch next sync */ }
		} else if (entry) {
			// Keep the local scene but refresh the pointers so we don't re-upload.
			const next = { ...entry, updatedAt: d.updatedAt ?? entry.updatedAt, driveId: d.driveId, sceneDriveId: d.sceneDriveId };
			if (JSON.stringify(next) !== JSON.stringify(entry)) { diagrams[d.id] = next; diagramsChanged = true; }
		}
	}
	return diagramsChanged;
}

// Write a merged page back to the sharded local stores. Image bytes are untouched
// (they live in IndexedDB); the diagrams map is updated by the caller.
async function writeLocalPage(merged: PageRecord): Promise<void> {
	const url = merged.url;
	if (merged.highlights.length) {
		await setPage<StoredHighlights>('hl', url, { url, ...(merged.title ? { title: merged.title } : {}), highlights: merged.highlights as StoredHighlights['highlights'] });
	} else {
		await removePage('hl', url);
	}
	if (merged.drawings.length) {
		await setPage<StoredDrawings>('dr', url, { url, strokes: merged.drawings as StoredDrawings['strokes'] });
	} else {
		await removePage('dr', url);
	}
	if (merged.videoItems.length) {
		await setPage<StoredVideo>('va', url, { url, ...(merged.videoId ? { videoId: merged.videoId } : {}), ...(merged.title ? { title: merged.title } : {}), items: merged.videoItems as VideoItem[] });
	} else {
		await removePage('va', url);
	}
}

// Drop the blob + scene + map entry for any diagram tombstoned in this merge.
async function cleanupTombstonedDiagrams(merged: PageRecord, diagrams: DiagramsMap, interactive: boolean): Promise<boolean> {
	let changed = false;
	for (const id of Object.keys(merged.tombstones.diagrams)) {
		if (diagrams[id]) { delete diagrams[id]; changed = true; }
		await deleteDiagramImage(id).catch(() => {});
		// Best-effort remote cleanup so blobs don't accumulate (by deterministic name).
		for (const name of [diagramFileName(id), `diagram-${id}.scene.json`]) {
			try {
				const f = await findInFolder('diagrams', name, interactive);
				if (f) await deleteDriveFile(f.id, interactive);
			} catch { /* leave orphan; harmless */ }
		}
	}
	return changed;
}

// Strip any stray image bytes before a page record is serialised to Drive.
function stripForUpload(rec: PageRecord): PageRecord {
	return {
		...rec,
		videoItems: rec.videoItems.map((it) => {
			if (!it.frame) return it;
			const { dataUrl, ...frameRest } = it.frame as VideoFrame;
			return { ...it, frame: frameRest };
		}),
	};
}

// --- Reconcile ---------------------------------------------------------------

// All sync operations are serialised so a full reconcile and a targeted push
// never interleave on the same page file.
let chain: Promise<void> = Promise.resolve();
function serialize(op: () => Promise<void>): Promise<void> {
	const next = chain.catch(() => {}).then(op);
	chain = next.catch(() => {});
	return next;
}

/**
 * Full reconcile: every page that exists locally or on Drive, each merged
 * independently (no whole-dataset merge). Used by the alarm, startup, and the
 * manual "Sync now" button.
 * @param interactive allow an OAuth consent window (manual "Sync now"/Connect).
 */
export async function sync(interactive = false): Promise<void> {
	if (!isConfigured()) {
		if (interactive) throw new Error('Google client id not configured');
		return;
	}
	return serialize(() => doFullSync(interactive));
}

/**
 * Targeted reconcile: only the given pages. Used by the on-change push so a single
 * edit syncs just its page, not the whole library.
 */
export async function syncChanged(urls: string[], interactive = false): Promise<void> {
	if (!isConfigured() || !urls.length) return;
	return serialize(async () => {
		await setStatus({ syncing: true, lastError: undefined });
		try {
			for (const url of urls) await syncPage(url, interactive);
			await setStatus({ connected: true, syncing: false, lastSyncedAt: Date.now(), lastError: undefined });
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			await setStatus({ syncing: false, lastError: message });
			throw err;
		}
	});
}

async function doFullSync(interactive: boolean): Promise<void> {
	await setStatus({ syncing: true, lastError: undefined });
	try {
		const urls = new Set<string>([
			...(await getAllUrls('hl')),
			...(await getAllUrls('dr')),
			...(await getAllUrls('va')),
		]);
		// Discover remote-only pages: list pages/, and for any file we don't have
		// locally, download it once to learn its url (the filename is a hash).
		const remoteFiles = await listFolder('pages', interactive);
		const metaByName = new Map<string, DriveFileMeta>();
		const localNames = new Set<string>();
		for (const u of urls) localNames.add(await pageFileName(u));
		for (const f of remoteFiles) {
			metaByName.set(f.name, f);
			if (!localNames.has(f.name)) {
				try {
					const rec = JSON.parse(await downloadDriveFile(f.id, interactive)) as PageRecord;
					if (rec?.url) urls.add(rec.url);
				} catch { /* skip corrupt */ }
			}
		}
		for (const url of urls) {
			const meta = metaByName.get(await pageFileName(url)) ?? null;
			await syncPage(url, interactive, meta);
		}
		await setStatus({ connected: true, syncing: false, lastSyncedAt: Date.now(), lastError: undefined });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await setStatus({ syncing: false, lastError: message });
		throw err;
	}
}

/**
 * Reconcile a single page: 3-way merge (snapshot/base + local + remote Drive
 * file), upload images, upload the merged page JSON (compare-and-swap on the
 * Drive revision), pull any missing images, then write the merge back locally.
 * `knownMeta` (when provided) skips the initial file lookup on the first attempt.
 */
async function syncPage(url: string, interactive: boolean, knownMeta?: DriveFileMeta | null): Promise<void> {
	const fileName = await pageFileName(url);
	const snap = ((await browser.storage.local.get(snapKey(url)))[snapKey(url)] as PageRecord) || null;

	for (let attempt = 0; attempt < 4; attempt++) {
		const now = Date.now();
		const fileMeta: DriveFileMeta | null =
			attempt === 0 && knownMeta !== undefined ? knownMeta : await findInFolder('pages', fileName, interactive);

		let remote: PageRecord | null = null;
		if (fileMeta) {
			try { remote = JSON.parse(await downloadDriveFile(fileMeta.id, interactive)) as PageRecord; }
			catch { remote = null; } // corrupt — treat as absent; this reconcile rewrites it
		}

		const diagrams = await loadDiagrams();
		const local = await assembleLocalPage(url, diagrams);
		const localBefore = JSON.stringify(local);

		await pushImages(local, snap, diagrams, interactive);
		const merged = mergePageRecord(snap, local, remote, now);

		// Upload the merged page JSON (image-free), CAS on the Drive revision.
		const mergedJson = JSON.stringify(stripForUpload(merged));
		const remoteJson = remote ? JSON.stringify(remote) : null;
		let outMeta: DriveFileMeta;
		if (!fileMeta) {
			outMeta = await createTextFile('pages', fileName, mergedJson, interactive);
		} else if (mergedJson === remoteJson) {
			outMeta = fileMeta; // nothing to upload
		} else {
			const fresh = await findInFolder('pages', fileName, interactive);
			if (fresh && fresh.headRevisionId !== fileMeta.headRevisionId && attempt < 3) continue; // remote moved — re-merge
			outMeta = await updateTextFile(fileMeta.id, mergedJson, interactive);
		}

		// If a content script edited this page during our network I/O, our merge is
		// stale — redo it rather than clobbering the edit.
		const localNow = JSON.stringify(await assembleLocalPage(url, await loadDiagrams()));
		if (localNow !== localBefore && attempt < 3) continue;

		const pulledDiagrams = await pullImages(merged, diagrams, interactive);
		await writeLocalPage(merged);
		const cleaned = await cleanupTombstonedDiagrams(merged, diagrams, interactive);
		if (pulledDiagrams || cleaned) await browser.storage.local.set({ [DIAGRAMS_KEY]: diagrams });

		await browser.storage.local.set({
			[snapKey(url)]: merged,
			[pageMetaKey(url)]: { fileId: outMeta.id, headRevisionId: outMeta.headRevisionId } as PageMeta,
		});
		return;
	}
}

/**
 * Pages that reference any of the given diagram ids in their highlight comments.
 * A diagram edit only touches the global `diagrams` map (not any `hl:` key), so the
 * background uses this to route a diagram change to the page(s) it belongs to.
 */
export async function findPagesForDiagrams(diagramIds: string[]): Promise<string[]> {
	if (!diagramIds.length) return [];
	const want = new Set(diagramIds);
	const all = await getAll<StoredHighlights>('hl');
	const out: string[] = [];
	for (const url of Object.keys(all)) {
		if (collectDiagramIds(all[url].highlights || []).some((id) => want.has(id))) out.push(url);
	}
	return out;
}

/** Clear local sync bookkeeping (called on disconnect). */
export async function resetSyncState(): Promise<void> {
	const all = await browser.storage.local.get(null);
	const keys = Object.keys(all).filter((k) => k === STATUS_KEY || k.startsWith('snap:') || k.startsWith('pagemeta:'));
	if (keys.length) await browser.storage.local.remove(keys);
}
