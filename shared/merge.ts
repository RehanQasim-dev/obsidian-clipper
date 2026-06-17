/**
 * Pure 3-way merge for the Drive `clipper-sync.json` annotation store.
 *
 * Lifted from the extension's `sync-engine.ts` so the Obsidian plugin can act as
 * a second Drive client using the *identical* conflict-resolution rules. No
 * `browser.*` / `obsidian` / I/O — just data in, merged data out — so it is
 * unit-testable and runs in either runtime.
 *
 * Reconciliation is the 3-way merge between:
 *   base   = the state we last reconciled (a stored snapshot)
 *   local  = this device's current state
 *   remote = whatever is in Drive right now
 * Deletions are detected against `base` and recorded as tombstones so a delete
 * on one device isn't resurrected by the other's stale copy.
 */

export interface Highlight {
	id: string;
	updatedAt?: number;
	notes?: string[];
	color?: string;
	[k: string]: unknown;
}
export interface StoredHighlights {
	url: string;
	title?: string;
	highlights: Highlight[];
}
export interface Stroke {
	id: string;
	updatedAt?: number;
	[k: string]: unknown;
}
export interface StoredDrawings {
	url: string;
	strokes: Stroke[];
}
export interface VideoItem {
	id: string;
	notes?: string[];
	updatedAt?: number;
	frame?: { dataUrl?: string; driveId?: string; [k: string]: unknown };
	[k: string]: unknown;
}
export interface StoredVideo {
	url: string;
	videoId?: string;
	title?: string;
	items: VideoItem[];
}

export type HighlightsStorage = Record<string, StoredHighlights>;
export type DrawingsStorage = Record<string, StoredDrawings>;
export type VideoStorage = Record<string, StoredVideo>;

export interface Tombstones {
	highlights: Record<string, number>; // highlightId -> deletedAt
	drawings: Record<string, number>; // strokeId -> deletedAt
	comments: Record<string, number>; // `${highlightId}:${commentTs}` -> deletedAt
	videoItems: Record<string, number>; // videoItemId -> deletedAt
}

export interface SyncFile {
	version: 1;
	highlights: HighlightsStorage;
	drawings: DrawingsStorage;
	videoAnnotations: VideoStorage;
	tombstones: Tombstones;
}

export function emptyTombstones(): Tombstones {
	return { highlights: {}, drawings: {}, comments: {}, videoItems: {} };
}

export function emptySyncFile(): SyncFile {
	return { version: 1, highlights: {}, drawings: {}, videoAnnotations: {}, tombstones: emptyTombstones() };
}

// Tombstones older than this are garbage-collected so the file can't grow forever.
export const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// --- Comment marker parsing (mirrors comment-overlays.parseNoteString) --------

export function commentId(note: string): string {
	const m = note.match(/<!--timestamp:(\d+)-->/);
	return m?.[1] ?? note; // fall back to raw text as id for legacy notes
}
export function commentVersion(note: string): number {
	const ed = note.match(/<!--edited:(\d+)-->/);
	if (ed?.[1]) return parseInt(ed[1], 10);
	const ts = note.match(/<!--timestamp:(\d+)-->/);
	return ts?.[1] ? parseInt(ts[1], 10) : 0;
}

// --- Generic keyed 3-way merge -----------------------------------------------

interface MergeResult<T> {
	kept: Map<string, T>;
	tombs: Record<string, number>;
}

export function mergeKeyed<T>(
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
	const ids = new Set<string>([...base.keys(), ...local.keys(), ...remote.keys(), ...Object.keys(inTombs)]);

	for (const id of ids) {
		const b = base.get(id);
		const l = local.get(id);
		const r = remote.get(id);
		const tomb = tombs[id];

		if (l && r) {
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
			} else if (!b) {
				kept.set(id, l); // brand-new local entity
			} else {
				tombs[id] = now; // was in base, gone from remote → remote deleted it
			}
		} else if (r && !l) {
			if (b) {
				tombs[id] = now; // was in base, gone locally → local deleted it
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

	for (const id of Object.keys(tombs)) {
		const t = tombs[id];
		if (t !== undefined && now - t > TOMBSTONE_RETENTION_MS) delete tombs[id];
	}

	return { kept, tombs };
}

function byId<T extends { id: string }>(arr: T[] | undefined): Map<string, T> {
	const m = new Map<string, T>();
	for (const e of arr || []) m.set(e.id, e);
	return m;
}

// --- Comment (notes[]) merge -------------------------------------------------

export function mergeNotes(
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

	const scoped: Record<string, number> = {};
	const prefix = `${highlightId}:`;
	for (const k of Object.keys(commentTombs)) {
		const v = commentTombs[k];
		if (v !== undefined && k.startsWith(prefix)) scoped[k.slice(prefix.length)] = v;
	}

	const { kept, tombs } = mergeKeyed<string>(
		base,
		local,
		remote,
		scoped,
		commentVersion,
		(l, r) => (commentVersion(l) >= commentVersion(r) ? l : r),
		now,
	);

	for (const k of Object.keys(scoped)) delete commentTombs[prefix + k];
	for (const k of Object.keys(tombs)) {
		const v = tombs[k];
		if (v !== undefined) commentTombs[prefix + k] = v;
	}

	return [...kept.values()].sort((a, b) => parseInt(commentId(a)) - parseInt(commentId(b)));
}

// --- Storage mergers ---------------------------------------------------------

function highlightVersion(h: Highlight): number {
	return h.updatedAt || parseInt(h.id, 10) || 0;
}

export function mergeHighlightsStorage(
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
			const notes = mergeNotes(bMap.get(l.id)?.notes, l.notes, r.notes, tombs.comments, l.id, now);
			return { ...newer, notes };
		};

		const { kept, tombs: hlTombs } = mergeKeyed(bMap, lMap, rMap, tombs.highlights, highlightVersion, combine, now);
		tombs.highlights = hlTombs;

		if (kept.size > 0) {
			const title = local[url]?.title ?? remote[url]?.title ?? base[url]?.title;
			out[url] = { url, ...(title ? { title } : {}), highlights: [...kept.values()] };
		}
	}
	return out;
}

export function mergeDrawingsStorage(
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
		if (kept.size > 0) out[url] = { url, strokes: [...kept.values()] };
	}
	return out;
}

function videoItemVersion(it: VideoItem): number {
	return it.updatedAt || parseInt(it.id, 10) || 0;
}

export function mergeVideoStorage(
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
			const frame = newer.frame || l.frame || r.frame;
			return { ...newer, notes, ...(frame ? { frame } : {}) };
		};

		const { kept, tombs: itTombs } = mergeKeyed(bMap, lMap, rMap, tombs.videoItems, videoItemVersion, combine, now);
		tombs.videoItems = itTombs;

		if (kept.size > 0) {
			const videoId = local[url]?.videoId ?? remote[url]?.videoId ?? base[url]?.videoId;
			const title = local[url]?.title ?? remote[url]?.title ?? base[url]?.title;
			out[url] = { url, ...(videoId ? { videoId } : {}), ...(title ? { title } : {}), items: [...kept.values()] };
		}
	}
	return out;
}

/**
 * Full 3-way reconcile of a {@link SyncFile}. Mutates a fresh tombstone set
 * (seeded from `remote`) and returns the merged file ready to upload.
 */
export function mergeSyncFiles(base: SyncFile, local: SyncFile, remote: SyncFile, now: number): SyncFile {
	const tombs: Tombstones = {
		highlights: { ...remote.tombstones.highlights },
		drawings: { ...remote.tombstones.drawings },
		comments: { ...remote.tombstones.comments },
		videoItems: { ...remote.tombstones.videoItems },
	};
	const highlights = mergeHighlightsStorage(base.highlights, local.highlights, remote.highlights, tombs, now);
	const drawings = mergeDrawingsStorage(base.drawings, local.drawings, remote.drawings, tombs, now);
	const videoAnnotations = mergeVideoStorage(base.videoAnnotations, local.videoAnnotations, remote.videoAnnotations, tombs, now);
	return { version: 1, highlights, drawings, videoAnnotations, tombstones: tombs };
}
