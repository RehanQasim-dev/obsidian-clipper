import browser from '../browser-polyfill';

// Binary store for captured video frame JPEGs, backed by IndexedDB.
//
// Why not chrome.storage.local (where everything else lives)? That store is a
// single JSON blob per key — every write re-serialises the WHOLE value, and it
// can only hold JSON, so images had to be inlined as base64 (~33% larger) inside
// the `video_annotations` blob. The result: editing one comment re-serialised
// every frame you'd ever captured, and the file grew without bound. IndexedDB
// stores the JPEG as a real `Blob` (no base64) in its own record, so frames are
// written/read individually and never touch the metadata blob.
//
// Origin caveat: a content script's `indexedDB` is the *page's* origin (e.g.
// youtube.com), which is NOT shared with the dashboard (an extension page). So
// the single source-of-truth DB lives in the EXTENSION origin: background +
// extension pages talk to it directly; content scripts route through the
// background via runtime messaging. `frame.dataUrl` becomes a runtime-only field
// (rehydrated on demand) and is never persisted in `video_annotations`.

const DB_NAME = 'clipper';
const DB_VERSION = 1;
const STORE = 'frames';
const MIGRATED_FLAG = 'video_frames_idb_migrated_v1';

const EXT_ORIGIN = (() => {
	try { return new URL(browser.runtime.getURL('/')).origin; } catch { return ''; }
})();

// True in the background service worker and any extension page (dashboard,
// settings, popup) — i.e. wherever `indexedDB` resolves to the extension origin.
function inExtensionContext(): boolean {
	return !!EXT_ORIGIN && typeof location !== 'undefined' && location.origin === EXT_ORIGIN;
}

let dbPromise: Promise<IDBDatabase> | null = null;
function openDb(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

function idbPut(id: string, blob: Blob): Promise<void> {
	return openDb().then(db => new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).put(blob, id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	}));
}

function idbGet(id: string): Promise<Blob | null> {
	return openDb().then(db => new Promise<Blob | null>((resolve, reject) => {
		const tx = db.transaction(STORE, 'readonly');
		const r = tx.objectStore(STORE).get(id);
		r.onsuccess = () => resolve((r.result as Blob) || null);
		r.onerror = () => reject(r.error);
	}));
}

function idbDelete(id: string): Promise<void> {
	return openDb().then(db => new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORE, 'readwrite');
		tx.objectStore(STORE).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	}));
}

function idbHas(id: string): Promise<boolean> {
	return openDb().then(db => new Promise<boolean>((resolve, reject) => {
		const tx = db.transaction(STORE, 'readonly');
		const r = tx.objectStore(STORE).getKey(id);
		r.onsuccess = () => resolve(r.result !== undefined);
		r.onerror = () => reject(r.error);
	}));
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
	return (await fetch(dataUrl)).blob();
}

function blobToDataUrl(blob: Blob): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const r = new FileReader();
		r.onloadend = () => resolve(r.result as string);
		r.onerror = () => reject(r.error);
		r.readAsDataURL(blob);
	});
}

// --- Public API (context-aware) ----------------------------------------------

export async function saveFrameImage(id: string, dataUrl: string): Promise<void> {
	if (inExtensionContext()) { await idbPut(id, await dataUrlToBlob(dataUrl)); return; }
	await browser.runtime.sendMessage({ action: 'frameStorePut', id, dataUrl });
}

export async function loadFrameImage(id: string): Promise<string | null> {
	if (inExtensionContext()) {
		const blob = await idbGet(id);
		return blob ? blobToDataUrl(blob) : null;
	}
	const res = await browser.runtime.sendMessage({ action: 'frameStoreGet', id }) as { dataUrl?: string } | undefined;
	return res?.dataUrl || null;
}

export async function deleteFrameImage(id: string): Promise<void> {
	if (inExtensionContext()) { await idbDelete(id); return; }
	await browser.runtime.sendMessage({ action: 'frameStoreDelete', id });
}

export async function hasFrameImage(id: string): Promise<boolean> {
	if (inExtensionContext()) return idbHas(id);
	const res = await browser.runtime.sendMessage({ action: 'frameStoreHas', id }) as { has?: boolean } | undefined;
	return !!res?.has;
}

// Background message handler. Routed here from background.ts so content scripts
// (page origin) reach the single extension-origin DB. Returns true if it handled
// the action (the caller should then `return true` to keep sendResponse alive).
export function handleFrameStoreMessage(
	action: string,
	req: { id?: string; dataUrl?: string },
	sendResponse: (r?: any) => void,
): boolean {
	if (!req.id) return false;
	if (action === 'frameStorePut' && req.dataUrl) {
		saveFrameImage(req.id, req.dataUrl).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: String(e) }));
		return true;
	}
	if (action === 'frameStoreGet') {
		loadFrameImage(req.id).then(dataUrl => sendResponse({ dataUrl })).catch(() => sendResponse({ dataUrl: null }));
		return true;
	}
	if (action === 'frameStoreDelete') {
		deleteFrameImage(req.id).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: String(e) }));
		return true;
	}
	if (action === 'frameStoreHas') {
		hasFrameImage(req.id).then(has => sendResponse({ has })).catch(() => sendResponse({ has: false }));
		return true;
	}
	return false;
}

// One-time migration: pull any inline base64 frames out of the `video_annotations`
// JSON into IndexedDB, then rewrite the (now image-free) metadata once. Idempotent
// and gated by a flag; safe to call on every startup. Extension-context only.
export async function migrateInlineFrames(): Promise<void> {
	if (!inExtensionContext()) return;
	const got = await browser.storage.local.get([MIGRATED_FLAG, 'video_annotations']);
	if (got[MIGRATED_FLAG]) return;
	const store = (got.video_annotations as Record<string, any>) || {};
	let changed = false;
	for (const url of Object.keys(store)) {
		for (const item of store[url].items || []) {
			const f = item.frame;
			if (f && f.dataUrl) {
				try { await idbPut(item.id, await dataUrlToBlob(f.dataUrl)); } catch { /* keep inline; retry next run */ continue; }
				delete f.dataUrl;
				changed = true;
			}
		}
	}
	if (changed) await browser.storage.local.set({ video_annotations: store });
	await browser.storage.local.set({ [MIGRATED_FLAG]: true });
}
