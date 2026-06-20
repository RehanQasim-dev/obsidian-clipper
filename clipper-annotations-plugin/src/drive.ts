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
import { type SyncFile, emptySyncFile } from '../../shared/merge';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const SYNC_FILENAME = 'clipper-sync.json';

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

	private async findFile(): Promise<{ id: string; headRevisionId?: string } | null> {
		const params = new URLSearchParams({
			spaces: 'appDataFolder',
			q: `name='${SYNC_FILENAME}' and trashed=false`,
			fields: 'files(id,name,headRevisionId)',
			pageSize: '1',
		});
		const res = await this.authed(`${DRIVE_FILES}?${params.toString()}`, { method: 'GET' });
		const files = (res.json as { files?: { id: string; headRevisionId?: string }[] }).files;
		return files?.[0] ?? null;
	}

	/**
	 * Download the remote sync file (or an empty one if it doesn't exist yet),
	 * along with the revision id observed at pull time — the caller passes that
	 * back to {@link push} so a concurrent write by another client is detected.
	 */
	async pull(): Promise<{ file: SyncFile; fileId: string | null; revision?: string }> {
		const meta = await this.findFile();
		if (!meta) return { file: emptySyncFile(), fileId: null };
		const res = await this.authed(`${DRIVE_FILES}/${meta.id}?alt=media`, { method: 'GET' });
		try {
			const parsed = JSON.parse(res.text) as Partial<SyncFile>;
			return {
				file: {
					version: 1,
					highlights: parsed.highlights || {},
					drawings: parsed.drawings || {},
					videoAnnotations: parsed.videoAnnotations || {},
					tombstones: { highlights: {}, drawings: {}, comments: {}, videoItems: {}, ...(parsed.tombstones || {}) },
				},
				fileId: meta.id,
				revision: meta.headRevisionId,
			};
		} catch {
			return { file: emptySyncFile(), fileId: meta.id, revision: meta.headRevisionId };
		}
	}

	/**
	 * Write the merged sync file back, creating it if needed. When `expectedRevision`
	 * is given, the current remote revision is re-checked first and {@link ConflictError}
	 * is thrown if it moved since pull — the caller re-pulls, re-merges, and retries
	 * (compare-and-swap), so a concurrent write is never silently clobbered.
	 */
	async push(file: SyncFile, fileId: string | null, expectedRevision?: string): Promise<void> {
		const content = JSON.stringify(file);
		if (fileId) {
			if (expectedRevision !== undefined) {
				const fresh = await this.findFile();
				if (fresh && fresh.headRevisionId !== expectedRevision) throw new ConflictError();
			}
			await this.authed(`${DRIVE_UPLOAD}/${fileId}?uploadType=media&fields=id`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: content,
			});
			return;
		}
		const boundary = '-------obsidianclipperplugin';
		const metadata = { name: SYNC_FILENAME, parents: ['appDataFolder'] };
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
