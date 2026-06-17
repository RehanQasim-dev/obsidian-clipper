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
const SYNC_FILENAME = 'clipper-sync.json';
const TOKEN_KEY = 'gdrive_token';

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

export async function findSyncFile(interactive = false): Promise<DriveFileMeta | null> {
	const params = new URLSearchParams({
		spaces: 'appDataFolder',
		q: `name='${SYNC_FILENAME}' and trashed=false`,
		fields: 'files(id,name,modifiedTime,headRevisionId)',
		pageSize: '1',
	});
	const res = await driveFetch(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' }, interactive);
	const data = await res.json();
	return data.files && data.files.length ? (data.files[0] as DriveFileMeta) : null;
}

export async function downloadSyncFile(fileId: string, interactive = false): Promise<string> {
	const res = await driveFetch(`${DRIVE_FILES}/${fileId}?alt=media`, { method: 'GET' }, interactive);
	return res.text();
}

/** Create the sync file in appDataFolder. Returns its new metadata. */
export async function createSyncFile(content: string, interactive = false): Promise<DriveFileMeta> {
	const boundary = '-------obsidianclippersync';
	const metadata = { name: SYNC_FILENAME, parents: ['appDataFolder'] };
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

/** Overwrite the sync file's contents. Returns updated metadata. */
export async function updateSyncFile(fileId: string, content: string, interactive = false): Promise<DriveFileMeta> {
	const res = await driveFetch(
		`${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id,name,modifiedTime,headRevisionId`,
		{ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: content },
		interactive,
	);
	return (await res.json()) as DriveFileMeta;
}

// --- Binary blobs (video frame images) ---------------------------------------
// Frame screenshots are kept as their own appDataFolder files rather than inlined
// into clipper-sync.json, so the (large) JPEG payloads never bloat the JSON that
// the 3-way merge parses/uploads on every sync. The sync engine stores each
// blob's Drive id in the frame's metadata and lazily fetches images it lacks.

/** Upload a base64 (no data: prefix) blob as a new appDataFolder file. */
export async function createBinaryFile(
	name: string,
	base64: string,
	mimeType: string,
	interactive = false,
): Promise<DriveFileMeta> {
	const boundary = '-------obsidianclipperblob';
	const metadata = { name, parents: ['appDataFolder'] };
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

/** Download a blob and return it as a `data:<mime>;base64,...` URL. */
export async function downloadBinaryFile(fileId: string, interactive = false): Promise<string> {
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

/** Best-effort delete of an appDataFolder file (e.g. an orphaned frame blob). */
export async function deleteDriveFile(fileId: string, interactive = false): Promise<void> {
	await driveFetch(`${DRIVE_FILES}/${fileId}`, { method: 'DELETE' }, interactive);
}
