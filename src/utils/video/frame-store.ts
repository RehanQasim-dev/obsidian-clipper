import browser from '../browser-polyfill';

// Binary image store backed by IndexedDB. Holds two kinds of images, each in its
// own object store of the same `clipper` DB:
//   - `frames`   — captured YouTube video frame JPEGs (keyed by video item id)
//   - `diagrams` — rendered Excalidraw comment-diagram PNGs (keyed by diagram id)
//
// Why not chrome.storage.local (where the metadata lives)? That store is a single
// JSON blob per key — every write re-serialises the WHOLE value, and it can only
// hold JSON, so images had to be inlined as base64 (~33% larger). Editing one
// comment then re-serialised every image, and the blob grew without bound.
// IndexedDB stores each image as a real `Blob` (no base64) in its own record, so
// images are written/read individually and never touch the metadata blob.
//
// Origin caveat: a content script's `indexedDB` is the *page's* origin (e.g.
// youtube.com), which is NOT shared with the dashboard (an extension page). So the
// single source-of-truth DB lives in the EXTENSION origin: background + extension
// pages talk to it directly; content scripts route through the background via
// runtime messaging. The image `dataUrl` is a runtime-only field (rehydrated on
// demand) and is never persisted in the metadata.

const DB_NAME = 'clipper';
const DB_VERSION = 2;
type StoreName = 'frames' | 'diagrams';
const STORES: StoreName[] = ['frames', 'diagrams'];

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
			for (const store of STORES) {
				if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
	return dbPromise;
}

function idbPut(store: StoreName, id: string, blob: Blob): Promise<void> {
	return openDb().then(db => new Promise<void>((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).put(blob, id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	}));
}

function idbGet(store: StoreName, id: string): Promise<Blob | null> {
	return openDb().then(db => new Promise<Blob | null>((resolve, reject) => {
		const tx = db.transaction(store, 'readonly');
		const r = tx.objectStore(store).get(id);
		r.onsuccess = () => resolve((r.result as Blob) || null);
		r.onerror = () => reject(r.error);
	}));
}

function idbDelete(store: StoreName, id: string): Promise<void> {
	return openDb().then(db => new Promise<void>((resolve, reject) => {
		const tx = db.transaction(store, 'readwrite');
		tx.objectStore(store).delete(id);
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	}));
}

function idbHas(store: StoreName, id: string): Promise<boolean> {
	return openDb().then(db => new Promise<boolean>((resolve, reject) => {
		const tx = db.transaction(store, 'readonly');
		const r = tx.objectStore(store).getKey(id);
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

// --- Generic context-aware blob access ---------------------------------------

async function saveImage(store: StoreName, id: string, dataUrl: string): Promise<void> {
	if (inExtensionContext()) { await idbPut(store, id, await dataUrlToBlob(dataUrl)); return; }
	await browser.runtime.sendMessage({ action: 'blobStorePut', store, id, dataUrl });
}

async function loadImage(store: StoreName, id: string): Promise<string | null> {
	if (inExtensionContext()) {
		const blob = await idbGet(store, id);
		return blob ? blobToDataUrl(blob) : null;
	}
	const res = await browser.runtime.sendMessage({ action: 'blobStoreGet', store, id }) as { dataUrl?: string } | undefined;
	return res?.dataUrl || null;
}

async function deleteImage(store: StoreName, id: string): Promise<void> {
	if (inExtensionContext()) { await idbDelete(store, id); return; }
	await browser.runtime.sendMessage({ action: 'blobStoreDelete', store, id });
}

async function hasImage(store: StoreName, id: string): Promise<boolean> {
	if (inExtensionContext()) return idbHas(store, id);
	const res = await browser.runtime.sendMessage({ action: 'blobStoreHas', store, id }) as { has?: boolean } | undefined;
	return !!res?.has;
}

// --- Public API: video frames -------------------------------------------------

export const saveFrameImage = (id: string, dataUrl: string) => saveImage('frames', id, dataUrl);
export const loadFrameImage = (id: string) => loadImage('frames', id);
export const deleteFrameImage = (id: string) => deleteImage('frames', id);
export const hasFrameImage = (id: string) => hasImage('frames', id);

// --- Public API: comment diagrams ---------------------------------------------

export const saveDiagramImage = (id: string, dataUrl: string) => saveImage('diagrams', id, dataUrl);
export const loadDiagramImage = (id: string) => loadImage('diagrams', id);
export const deleteDiagramImage = (id: string) => deleteImage('diagrams', id);
export const hasDiagramImage = (id: string) => hasImage('diagrams', id);

// Wipe every image blob (both stores). Extension-context only (the background owns
// the DB); used by the "delete local data" action.
export async function clearAllImages(): Promise<void> {
	if (!inExtensionContext()) return;
	const db = await openDb();
	await new Promise<void>((resolve, reject) => {
		const tx = db.transaction(STORES, 'readwrite');
		for (const s of STORES) tx.objectStore(s).clear();
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
	});
}

// Background message handler. Routed here from background.ts so content scripts
// (page origin) reach the single extension-origin DB. Returns true if it handled
// the action (the caller should then `return true` to keep sendResponse alive).
export function handleFrameStoreMessage(
	action: string,
	req: { store?: StoreName; id?: string; dataUrl?: string },
	sendResponse: (r?: any) => void,
): boolean {
	const store = req.store;
	if (!req.id || !store || !STORES.includes(store)) return false;
	if (action === 'blobStorePut' && req.dataUrl) {
		saveImage(store, req.id, req.dataUrl).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: String(e) }));
		return true;
	}
	if (action === 'blobStoreGet') {
		loadImage(store, req.id).then(dataUrl => sendResponse({ dataUrl })).catch(() => sendResponse({ dataUrl: null }));
		return true;
	}
	if (action === 'blobStoreDelete') {
		deleteImage(store, req.id).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: String(e) }));
		return true;
	}
	if (action === 'blobStoreHas') {
		hasImage(store, req.id).then(has => sendResponse({ has })).catch(() => sendResponse({ has: false }));
		return true;
	}
	return false;
}
