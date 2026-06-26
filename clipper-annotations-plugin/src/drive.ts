/**
 * Google Drive client for the plugin — the transport that makes it a second
 * client of the same `clipper-sync.json` the browser extension syncs to.
 *
 * Auth uses Google's **OAuth 2.0 Authorization Code flow** (Desktop app):
 * The plugin opens the browser for authorization, the user approves, and the
 * browser redirects to a local dead-end URL (127.0.0.1). The user copies that
 * URL and pastes it back into the plugin to complete the login. This works
 * on both desktop and mobile without requiring a local HTTP server.
 *
 * SETUP (one-time, by the user): in the same Google Cloud project as the
 * extension, create an OAuth client of type **"Desktop app"**, enable the
 * Drive API, and add the drive.appdata scope. Paste that client id
 * (and the desktop client secret — not confidential for installed apps)
 * into the plugin settings.
 *
 * All requests go through Obsidian's `requestUrl` to avoid CORS.
 */

import { requestUrl } from 'obsidian';
import { type PageRecord } from '../../shared/merge';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const PAGES_FOLDER = 'pages';

export interface DriveFileMeta {
	id: string;
	name: string;
	headRevisionId?: string;
}

export interface DriveTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number; // epoch ms
}

export interface AuthCodeRequest {
	authUrl: string;
	codeVerifier: string;
}

export interface DriveAuthStore {
	getTokens(): DriveTokens | null;
	setTokens(t: DriveTokens | null): Promise<void>;
}

/** Thrown by {@link DriveClient.push} when the remote file changed since pull. */
export class ConflictError extends Error {
	constructor() {
		super('Drive file changed since last pull');
		this.name = 'ConflictError';
	}
}

function form(params: Record<string, string>): string {
	return Object.entries(params)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join('&');
}

export class DriveClient {
	private clientId: string;
	private clientSecret: string;
	private auth: DriveAuthStore;

	constructor(clientId: string, clientSecret: string, auth: DriveAuthStore) {
		this.clientId = clientId.trim();
		this.clientSecret = clientSecret.trim();
		this.auth = auth;
	}

	isConfigured(): boolean {
		return this.clientId.length > 0;
	}

	isConnected(): boolean {
		return !!this.auth.getTokens()?.refreshToken;
	}

	// --- manual auth-code flow -----------------------------------------------

	private async generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
		const array = new Uint8Array(32);
		window.crypto.getRandomValues(array);
		const verifier = btoa(String.fromCharCode(...array)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		const buffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
		const challenge = btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		return { codeVerifier: verifier, codeChallenge: challenge };
	}

	/** Step 1: Generate the auth URL for the user to open. */
	async requestAuthCode(): Promise<AuthCodeRequest> {
		const { codeVerifier, codeChallenge } = await this.generatePkce();
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: 'http://127.0.0.1',
			response_type: 'code',
			scope: SCOPE,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			access_type: 'offline',
			prompt: 'consent'
		});
		return { authUrl: `${AUTH_ENDPOINT}?${params.toString()}`, codeVerifier };
	}

	/** Step 2: Exchange the pasted code for tokens. */
	async exchangeCode(code: string, codeVerifier: string): Promise<void> {
		const res = await requestUrl({
			url: TOKEN_ENDPOINT,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: form({
				client_id: this.clientId,
				client_secret: this.clientSecret,
				code,
				code_verifier: codeVerifier,
				redirect_uri: 'http://127.0.0.1',
				grant_type: 'authorization_code',
			}),
			throw: false,
		});
		if (res.status >= 400) throw new Error(`Code exchange failed (${res.status}): ${res.text.slice(0, 200)}`);
		const data = res.json as Record<string, string | number>;
		if (data.access_token) {
			await this.auth.setTokens({
				accessToken: data.access_token as string,
				refreshToken: data.refresh_token as string | undefined,
				expiresAt: Date.now() + ((data.expires_in as number) - 60) * 1000,
			});
		} else {
			throw new Error('No access token returned.');
		}
	}

	async disconnect(): Promise<void> {
		await this.auth.setTokens(null);
	}

	private async accessToken(): Promise<string> {
		const tokens = this.auth.getTokens();
		if (!tokens) throw new Error('Not connected to Google Drive.');
		if (tokens.accessToken && tokens.expiresAt > Date.now()) return tokens.accessToken;
		if (!tokens.refreshToken) throw new Error('Drive session expired — reconnect.');
		const res = await requestUrl({
			url: TOKEN_ENDPOINT,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: form({
				client_id: this.clientId,
				client_secret: this.clientSecret,
				refresh_token: tokens.refreshToken,
				grant_type: 'refresh_token',
			}),
			throw: false,
		});
		if (res.status >= 400) throw new Error(`Token refresh failed (${res.status}).`);
		const data = res.json as Record<string, string | number>;
		const next: DriveTokens = {
			accessToken: data.access_token as string,
			refreshToken: tokens.refreshToken,
			expiresAt: Date.now() + ((data.expires_in as number) - 60) * 1000,
		};
		await this.auth.setTokens(next);
		return next.accessToken;
	}

	// --- sync file I/O -------------------------------------------------------

	private async authed(url: string, init: { method: string; headers?: Record<string, string>; body?: string }) {
		const token = await this.accessToken();
		const res = await requestUrl({
			url,
			method: init.method,
			headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
			body: init.body,
			throw: false,
		});
		if (res.status >= 400) throw new Error(`Drive API ${res.status}: ${res.text.slice(0, 200)}`);
		return res;
	}

	// --- per-page layout (matches the extension's pages/ folder) -------------

	private pagesFolderId: string | null = null;

	private async ensurePagesFolder(): Promise<string> {
		if (this.pagesFolderId) return this.pagesFolderId;
		const params = new URLSearchParams({
			spaces: 'appDataFolder',
			q: `name='${PAGES_FOLDER}' and mimeType='${FOLDER_MIME}' and trashed=false`,
			fields: 'files(id,name)',
			pageSize: '1',
		});
		const res = await this.authed(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' });
		let id = (res.json as { files?: { id: string }[] }).files?.[0]?.id;
		if (!id) {
			const meta = { name: PAGES_FOLDER, mimeType: FOLDER_MIME, parents: ['appDataFolder'] };
			const cres = await this.authed(`${DRIVE_FILES}?fields=id`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(meta),
			});
			id = (cres.json as { id: string }).id;
		}
		this.pagesFolderId = id;
		return id;
	}

	/** List every page record file (the listing doubles as the change manifest). */
	async listPages(): Promise<DriveFileMeta[]> {
		const parent = await this.ensurePagesFolder();
		const out: DriveFileMeta[] = [];
		let pageToken: string | undefined;
		do {
			const params = new URLSearchParams({
				spaces: 'appDataFolder',
				q: `'${parent}' in parents and trashed=false`,
				fields: 'nextPageToken,files(id,name,headRevisionId)',
				pageSize: '1000',
			});
			if (pageToken) params.set('pageToken', pageToken);
			const res = await this.authed(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' });
			const data = res.json as { nextPageToken?: string; files?: DriveFileMeta[] };
			out.push(...(data.files || []));
			pageToken = data.nextPageToken;
		} while (pageToken);
		return out;
	}

	private async findPage(name: string): Promise<DriveFileMeta | null> {
		const parent = await this.ensurePagesFolder();
		const params = new URLSearchParams({
			spaces: 'appDataFolder',
			q: `'${parent}' in parents and name='${name}' and trashed=false`,
			fields: 'files(id,name,headRevisionId)',
			pageSize: '1',
		});
		const res = await this.authed(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' });
		return (res.json as { files?: DriveFileMeta[] }).files?.[0] ?? null;
	}

	/** Parse a page record by file id (used to discover a remote-only page's url). */
	async getPageById(fileId: string): Promise<PageRecord | null> {
		const res = await this.authed(`${DRIVE_FILES}/${fileId}?alt=media`, { method: 'GET' });
		try { return JSON.parse(res.text) as PageRecord; } catch { return null; }
	}

	/**
	 * Fetch a page's record + the revision observed at pull time (passed back to
	 * {@link pushPage} so a concurrent write is detected). Null if it doesn't exist.
	 */
	async pullPage(name: string): Promise<{ record: PageRecord | null; fileId: string | null; revision?: string }> {
		const meta = await this.findPage(name);
		if (!meta) return { record: null, fileId: null };
		return { record: await this.getPageById(meta.id), fileId: meta.id, revision: meta.headRevisionId };
	}

	/**
	 * Write a merged page record back, creating it if needed. With `expectedRevision`
	 * the remote revision is re-checked first and {@link ConflictError} thrown if it
	 * moved since pull, so the caller re-pulls/re-merges (compare-and-swap).
	 */
	async pushPage(name: string, record: PageRecord, fileId: string | null, expectedRevision?: string): Promise<void> {
		const content = JSON.stringify(record);
		if (fileId) {
			if (expectedRevision !== undefined) {
				const fresh = await this.findPage(name);
				if (fresh && fresh.headRevisionId !== expectedRevision) throw new ConflictError();
			}
			await this.authed(`${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: content,
			});
			return;
		}
		const parent = await this.ensurePagesFolder();
		const boundary = '-------obsidianclipperplugin';
		const metadata = { name, parents: [parent] };
		const body =
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
			`--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n` +
			`--${boundary}--`;
		await this.authed(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
			method: 'POST',
			headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
			body,
		});
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
