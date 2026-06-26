import browser from './browser-polyfill';

// Per-page sharded storage for annotation data.
//
// chrome.storage.local treats each top-level key as a single opaque blob, so a
// `set` re-serialises the WHOLE value. If every page shared one key (e.g.
// `highlights` = Record<normalizedUrl, StoredData>), editing one comment would
// re-serialise every annotation on every page ever made — O(total dataset) per
// keystroke-save — and two tabs racing on that key would lose each other's writes.
//
// So each page is keyed on its own: `hl:<normalizedUrl>`, `dr:<…>`, `va:<…>`. A
// write touches only that page's record (O(page)), and cross-tab collisions shrink
// to the same-page case. The dashboard / sync / Obsidian paths still want the whole
// map, so `getAll` reassembles it via `get(null)` + prefix filter (chrome.storage
// has no prefix scan). Binary frame JPEGs stay in IndexedDB (frame-store).

export type PageKind = 'hl' | 'dr' | 'va';

const PREFIX: Record<PageKind, string> = { hl: 'hl:', dr: 'dr:', va: 'va:' };
const ALL_KINDS: PageKind[] = ['hl', 'dr', 'va'];

const keyFor = (kind: PageKind, url: string) => PREFIX[kind] + url;

// --- single-page access (the hot path for content-script saves) --------------

export async function getPage<T>(kind: PageKind, url: string): Promise<T | null> {
	const k = keyFor(kind, url);
	const got = await browser.storage.local.get(k);
	return (got[k] as T) ?? null;
}

export async function setPage<T>(kind: PageKind, url: string, value: T): Promise<void> {
	await browser.storage.local.set({ [keyFor(kind, url)]: value });
}

export async function removePage(kind: PageKind, url: string): Promise<void> {
	await browser.storage.local.remove(keyFor(kind, url));
}

// --- whole-map access (dashboard / sync / Obsidian) --------------------------

export async function getAll<T>(kind: PageKind): Promise<Record<string, T>> {
	const all = await browser.storage.local.get(null);
	const pfx = PREFIX[kind];
	const out: Record<string, T> = {};
	for (const k of Object.keys(all)) {
		if (k.startsWith(pfx)) out[k.slice(pfx.length)] = all[k] as T;
	}
	return out;
}

export async function getAllUrls(kind: PageKind): Promise<string[]> {
	const all = await browser.storage.local.get(null);
	const pfx = PREFIX[kind];
	return Object.keys(all).filter(k => k.startsWith(pfx)).map(k => k.slice(pfx.length));
}

export async function clearAll(kind: PageKind): Promise<void> {
	const keys = (await getAllUrls(kind)).map(u => keyFor(kind, u));
	if (keys.length) await browser.storage.local.remove(keys);
}

// Replace the whole map for a kind, writing ONLY the pages that actually changed
// and removing the ones that vanished. Used by the sync engine's merge write-back
// so a periodic reconcile doesn't rewrite every page it didn't touch.
export async function setAll<T>(kind: PageKind, next: Record<string, T>): Promise<void> {
	const existing = await getAll<T>(kind);
	const toSet: Record<string, T> = {};
	for (const [url, val] of Object.entries(next)) {
		if (JSON.stringify(existing[url]) !== JSON.stringify(val)) toSet[keyFor(kind, url)] = val;
		delete existing[url];
	}
	const toRemove = Object.keys(existing).map(u => keyFor(kind, u));
	if (Object.keys(toSet).length) await browser.storage.local.set(toSet);
	if (toRemove.length) await browser.storage.local.remove(toRemove);
}

// --- storage.onChanged helpers -----------------------------------------------

// Normalized URLs whose page record changed in a storage.onChanged batch, per kind.
export function changedPages(
	changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
): Record<PageKind, string[]> {
	const out: Record<PageKind, string[]> = { hl: [], dr: [], va: [] };
	for (const k of Object.keys(changes)) {
		for (const kind of ALL_KINDS) {
			if (k.startsWith(PREFIX[kind])) out[kind].push(k.slice(PREFIX[kind].length));
		}
	}
	return out;
}

// Did any page of any of the given kinds change in this batch?
export function anyPageChanged(
	changes: Record<string, unknown>,
	kinds: PageKind[],
): boolean {
	return Object.keys(changes).some(k => kinds.some(kind => k.startsWith(PREFIX[kind])));
}
