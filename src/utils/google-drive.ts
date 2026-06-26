import browser from './browser-polyfill';

// Google Drive client for the annotation sync feature.
//
// Auth: OAuth 2.0 *implicit* grant via browser.identity.launchWebAuthFlow. This
// works in both Chrome and Firefox (unlike chrome.identity.getAuthToken, which is
// Chrome-only and tied to a published extension id) and needs no client secret —
// so nothing secret is embedded in the shipped extension. The access token is
// short-lived (~1h); when it expires we silently re-mint it with prompt=none, and
// only fall back to an interactive consent window if the silent attempt fails.
//
// Storage: a single JSON file `clipper-sync.json` lives in Drive's appDataFolder —
// a hidden, per-application folder. It never appears in the user's normal Drive UI
// and the extension can only ever see its own files (scope drive.appdata).
//
// SETUP (one-time, by the user): create a Google Cloud project, enable the Drive
// API, configure an OAuth consent screen (External + add yourself as a Test user),
// create an OAuth client of type "Web application", and register the redirect URI
// that getRedirectUrl() returns in each browser. Then paste the client id below.
// On first connect the redirect URI is logged to the service-worker console.

// 👇 PASTE YOUR OAUTH CLIENT ID HERE (looks like 1234567890-abc...apps.googleusercontent.com)
// No client secret is needed — this uses the OAuth implicit flow.
export const GOOGLE_CLIENT_ID = '625860450889-1elphiutt0jjmdv0n92kdqu3ng5pmu3i.apps.googleusercontent.com';

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_KEY = 'gdrive_token';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// Per-page Drive layout (all inside the hidden appDataFolder):
//   pages/page-<urlhash>.json   one record per normalized URL
//   frames/frame-<itemId>.jpg   video frame image blobs
//   diagrams/diagram-<id>.png   Excalidraw comment-diagram image blobs
export type DriveFolder = 'pages' | 'frames' | 'diagrams';

interface CachedToken {
	accessToken: string;
	expiresAt: number; // epoch ms
}

export interface DriveFileMeta {
	id: string;
	name: string;
	modifiedTime?: string;
	headRevisionId?: string;
}

export function getRedirectUrl(): string {
	return browser.identity.getRedirectURL();
}

export function isConfigured(): boolean {
	return GOOGLE_CLIENT_ID.trim().length > 0;
}

// --- Auth --------------------------------------------------------------------

function buildAuthUrl(interactive: boolean): string {
	const params = new URLSearchParams({
		client_id: GOOGLE_CLIENT_ID,
		response_type: 'token',
		redirect_uri: getRedirectUrl(),
		scope: SCOPE,
		// Silent renewals must not pop UI; the first/interactive grant asks for consent.
		prompt: interactive ? 'consent' : 'none',
	});
	return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function parseTokenFromRedirect(redirectUrl: string): CachedToken {
	// Implicit grant returns the token in the URL fragment:
	// https://<id>.chromiumapp.org/#access_token=...&expires_in=3600&token_type=Bearer
	const frag = redirectUrl.split('#')[1] || '';
	const params = new URLSearchParams(frag);
	const accessToken = params.get('access_token');
	const expiresIn = parseInt(params.get('expires_in') || '3600', 10);
	const error = params.get('error');
	if (error) throw new Error(`OAuth error: ${error}`);
	if (!accessToken) throw new Error('No access token in OAuth response');
	// Refresh a minute early to avoid using a token that expires mid-request.
	return { accessToken, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
}

async function launch(interactive: boolean): Promise<CachedToken> {
	const redirect = await browser.identity.launchWebAuthFlow({
		url: buildAuthUrl(interactive),
		interactive,
	});
	if (!redirect) throw new Error('OAuth flow returned no redirect');
	const token = parseTokenFromRedirect(redirect);
	await browser.storage.local.set({ [TOKEN_KEY]: token });
	return token;
}

async function getCachedToken(): Promise<CachedToken | null> {
	const result = await browser.storage.local.get(TOKEN_KEY);
	return (result[TOKEN_KEY] as CachedToken) || null;
}

/**
 * Return a valid access token, minting/refreshing as needed.
 * @param interactive when true, may open a consent window; when false, fails if
 *   silent renewal isn't possible (used by background/auto syncs).
 */
export async function getAccessToken(interactive: boolean): Promise<string> {
	if (!isConfigured()) throw new Error('Google client id not configured');

	const cached = await getCachedToken();
	if (cached && cached.expiresAt > Date.now()) return cached.accessToken;

	// Try a silent renewal first (works once the user has granted consent).
	try {
		const token = await launch(false);
		return token.accessToken;
	} catch (err) {
		if (!interactive) throw err;
	}
	// Interactive consent fallback.
	const token = await launch(true);
	return token.accessToken;
}

export async function isConnected(): Promise<boolean> {
	const cached = await getCachedToken();
	return !!cached;
}

export async function disconnect(): Promise<void> {
	const cached = await getCachedToken();
	await browser.storage.local.remove(TOKEN_KEY);
	// Best-effort revoke so re-connecting prompts cleanly and Drive access is dropped.
	if (cached?.accessToken) {
		try {
			await fetch(`https://oauth2.googleapis.com/revoke?token=${cached.accessToken}`, { method: 'POST' });
		} catch {
			/* offline / already revoked — token is cleared locally regardless */
		}
	}
}

/** Force an interactive consent flow (used by the Connect button). */
export async function connect(): Promise<void> {
	await launch(true);
}

// --- Drive REST --------------------------------------------------------------

async function driveFetch(url: string, init: RequestInit, interactive = false): Promise<Response> {
	let token = await getAccessToken(interactive);
	let res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
	if (res.status === 401) {
		// Token rejected (revoked / clock skew) — drop it and re-mint once.
		await browser.storage.local.remove(TOKEN_KEY);
		token = await getAccessToken(interactive);
		res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
	}
	if (!res.ok) {
		const body = await res.text().catch(() => '');
		throw new Error(`Drive API ${res.status}: ${body.slice(0, 300)}`);
	}
	return res;
}

// --- Folders ------------------------------------------------------------------
// The three subfolders (pages/frames/diagrams) live directly under appDataFolder.
// Their ids are resolved once per session and cached; created on first use.

const folderIdCache = new Map<DriveFolder, string>();

async function ensureFolder(folder: DriveFolder, interactive: boolean): Promise<string> {
	const cached = folderIdCache.get(folder);
	if (cached) return cached;
	const params = new URLSearchParams({
		spaces: 'appDataFolder',
		q: `name='${folder}' and mimeType='${FOLDER_MIME}' and trashed=false`,
		fields: 'files(id,name)',
		pageSize: '1',
	});
	const res = await driveFetch(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' }, interactive);
	const data = await res.json();
	let id: string | undefined = data.files?.[0]?.id;
	if (!id) {
		const meta = { name: folder, mimeType: FOLDER_MIME, parents: ['appDataFolder'] };
		const cres = await driveFetch(
			`${DRIVE_FILES}?fields=id`,
			{ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meta) },
			interactive,
		);
		id = (await cres.json()).id as string;
	}
	folderIdCache.set(folder, id);
	return id;
}

// --- Per-page JSON files ------------------------------------------------------

/** List every file in a folder with the fields needed as a change manifest. */
export async function listFolder(folder: DriveFolder, interactive = false): Promise<DriveFileMeta[]> {
	const parent = await ensureFolder(folder, interactive);
	const out: DriveFileMeta[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			spaces: 'appDataFolder',
			q: `'${parent}' in parents and trashed=false`,
			fields: 'nextPageToken,files(id,name,modifiedTime,headRevisionId)',
			pageSize: '1000',
		});
		if (pageToken) params.set('pageToken', pageToken);
		const res = await driveFetch(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' }, interactive);
		const data = await res.json();
		for (const f of data.files || []) out.push(f as DriveFileMeta);
		pageToken = data.nextPageToken;
	} while (pageToken);
	return out;
}

/** Find a single file by exact name within a folder. */
export async function findInFolder(folder: DriveFolder, name: string, interactive = false): Promise<DriveFileMeta | null> {
	const parent = await ensureFolder(folder, interactive);
	const params = new URLSearchParams({
		spaces: 'appDataFolder',
		q: `'${parent}' in parents and name='${name}' and trashed=false`,
		fields: 'files(id,name,modifiedTime,headRevisionId)',
		pageSize: '1',
	});
	const res = await driveFetch(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' }, interactive);
	const data = await res.json();
	return data.files?.length ? (data.files[0] as DriveFileMeta) : null;
}

/** Create a JSON text file in a folder. */
export async function createTextFile(folder: DriveFolder, name: string, content: string, interactive = false): Promise<DriveFileMeta> {
	const parent = await ensureFolder(folder, interactive);
	const boundary = '-------obsidianclippertext';
	const metadata = { name, parents: [parent] };
	const body =
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
		`--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
		`--${boundary}--`;
	const res = await driveFetch(
		`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name,modifiedTime,headRevisionId`,
		{ method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
		interactive,
	);
	return (await res.json()) as DriveFileMeta;
}

/** Overwrite a file's text content. Returns updated metadata. */
export async function updateTextFile(fileId: string, content: string, interactive = false): Promise<DriveFileMeta> {
	const res = await driveFetch(
		`${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id,name,modifiedTime,headRevisionId`,
		{ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content },
		interactive,
	);
	return (await res.json()) as DriveFileMeta;
}

/** Download a text (JSON) file's content. */
export async function downloadDriveFile(fileId: string, interactive = false): Promise<string> {
	const res = await driveFetch(`${DRIVE_FILES}/${fileId}?alt=media`, { method: 'GET' }, interactive);
	return res.text();
}

// --- Binary image blobs (frames + diagrams) -----------------------------------
// Image bytes are kept as their own folder files rather than inlined into any
// JSON, so the (large) payloads never bloat the per-page records the 3-way merge
// parses/uploads. The sync engine stores each blob's Drive id in the metadata and
// lazily fetches images it lacks.

function base64ToBytes(base64: string): Uint8Array {
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/** Upload a base64 (no data: prefix) blob into a folder. Returns its metadata. */
export async function uploadBlob(folder: DriveFolder, name: string, base64: string, mimeType: string, interactive = false): Promise<DriveFileMeta> {
	const parent = await ensureFolder(folder, interactive);
	const boundary = '-------obsidianclipperblob';
	const metadata = { name, parents: [parent] };
	const body =
		`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
		`--${boundary}\r\nContent-Type: ${mimeType}\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64}\r\n` +
		`--${boundary}--`;
	const res = await driveFetch(
		`${DRIVE_UPLOAD}?uploadType=multipart&fields=id,name`,
		{ method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
		interactive,
	);
	return (await res.json()) as DriveFileMeta;
}

/** Replace an existing blob's bytes (e.g. an edited diagram). */
export async function updateBlob(fileId: string, base64: string, mimeType: string, interactive = false): Promise<DriveFileMeta> {
	const res = await driveFetch(
		`${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id,name`,
		{ method: 'PATCH', headers: { 'Content-Type': mimeType }, body: base64ToBytes(base64) },
		interactive,
	);
	return (await res.json()) as DriveFileMeta;
}

/** Download a blob and return it as a `data:<mime>;base64,...` URL. */
export async function downloadBlob(fileId: string, interactive = false): Promise<string> {
	const res = await driveFetch(`${DRIVE_FILES}/${fileId}?alt=media`, { method: 'GET' }, interactive);
	const buf = await res.arrayBuffer();
	const bytes = new Uint8Array(buf);
	let binary = '';
	const chunk = 0x8000; // chunk to avoid call-stack limits on String.fromCharCode
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
	}
	const mime = res.headers.get('Content-Type') || 'image/jpeg';
	return `data:${mime};base64,${btoa(binary)}`;
}

/** Best-effort delete of an appDataFolder file (page record or orphaned blob). */
export async function deleteDriveFile(fileId: string, interactive = false): Promise<void> {
	await driveFetch(`${DRIVE_FILES}/${fileId}`, { method: 'DELETE' }, interactive);
}

/**
 * Delete EVERY file the extension owns in appDataFolder (the pages/frames/diagrams
 * folders — deleting a folder cascades to its children — plus any legacy root files
 * like `clipper-sync.json`). Returns how many top-level items were deleted. Runs
 * non-interactively (renews the token silently; never opens a consent window — a
 * delete must not block on UI), and clears the folder-id cache so a later sync
 * recreates the layout.
 */
export async function wipeAppData(interactive = false): Promise<number> {
	let count = 0;
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			spaces: 'appDataFolder',
			// Only the direct children of appDataFolder — deleting a folder takes its
			// descendants with it, so this is a handful of calls, not one per file.
			q: `'appDataFolder' in parents and trashed=false`,
			fields: 'nextPageToken,files(id)',
			pageSize: '1000',
		});
		if (pageToken) params.set('pageToken', pageToken);
		const res = await driveFetch(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' }, interactive);
		const data = await res.json();
		for (const f of data.files || []) {
			try { await deleteDriveFile(f.id, interactive); count++; } catch { /* already gone */ }
		}
		pageToken = data.nextPageToken;
	} while (pageToken);
	folderIdCache.clear();
	return count;
}
