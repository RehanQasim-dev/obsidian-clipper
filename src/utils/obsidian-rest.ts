import browser from './browser-polyfill';

// Thin client for the Obsidian "Local REST API" community plugin, used to write
// annotation notes (and frame images) straight into the vault.
//
// Transport notes (verified against the plugin source):
//   - Auth: `Authorization: Bearer <apiKey>`. `GET /` is the health/auth check.
//   - `PUT /vault/<path>` with `text/markdown` writes a note; with `image/jpeg`
//     (raw bytes) writes a binary attachment. `GET /vault/<path>` reads a note
//     (404 when it doesn't exist).
//   - The plugin's HTTPS server (27124) uses a self-signed cert an extension
//     `fetch` can't validate, so we talk to its **insecure HTTP** server on
//     127.0.0.1:27123. The user must enable that server in the plugin settings.

const CONFIG_KEY = 'obsidian_rest_config';

export type ClipTheme = 'cards' | 'document';

export interface ObsidianRestConfig {
	enabled: boolean;
	baseUrl: string; // e.g. http://127.0.0.1:27123
	apiKey: string;
	folder: string; // vault base folder for clipped notes, e.g. "Clippings"
	theme: ClipTheme; // note styling theme
	cssVersion?: number; // version of the CSS snippet last written to the vault
}

export const DEFAULT_CONFIG: ObsidianRestConfig = {
	enabled: false,
	baseUrl: 'http://127.0.0.1:27123',
	apiKey: '',
	folder: 'Clippings',
	theme: 'cards',
	cssVersion: 0,
};

export async function getConfig(): Promise<ObsidianRestConfig> {
	const stored = (await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as Partial<ObsidianRestConfig> | undefined;
	return { ...DEFAULT_CONFIG, ...(stored || {}) };
}

export async function setConfig(patch: Partial<ObsidianRestConfig>): Promise<ObsidianRestConfig> {
	const next = { ...(await getConfig()), ...patch };
	await browser.storage.local.set({ [CONFIG_KEY]: next });
	return next;
}

function authHeaders(cfg: ObsidianRestConfig): Record<string, string> {
	return cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {};
}

function vaultUrl(cfg: ObsidianRestConfig, path: string): string {
	const encoded = path.split('/').map(encodeURIComponent).join('/');
	return `${cfg.baseUrl.replace(/\/$/, '')}/vault/${encoded}`;
}

/** True when the plugin is reachable AND the API key is accepted. */
export async function ping(cfg: ObsidianRestConfig): Promise<boolean> {
	let res: Response;
	try {
		res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/`, { headers: authHeaders(cfg) });
	} catch {
		return false; // network error → Obsidian/plugin not running
	}
	// `GET /` always returns 200 with `{ status, authenticated }` — even without a
	// valid key — so reachability alone isn't enough; require authenticated:true.
	if (res.status === 401) throw new Error('Obsidian REST API: unauthorized (check your API key)');
	let body: { authenticated?: boolean } = {};
	try {
		body = await res.json();
	} catch {
		/* unexpected body — fall through to the auth check below */
	}
	if (!body.authenticated) throw new Error('Obsidian REST API: unauthorized (check your API key)');
	return true;
}

/** Read a note's contents, or null if it doesn't exist yet. */
export async function getNote(cfg: ObsidianRestConfig, path: string): Promise<string | null> {
	const res = await fetch(vaultUrl(cfg, path), { headers: authHeaders(cfg) });
	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`Obsidian GET ${res.status}: ${(await res.text()).slice(0, 200)}`);
	return res.text();
}

/** Create or overwrite a note. */
export async function putNote(cfg: ObsidianRestConfig, path: string, markdown: string): Promise<void> {
	const res = await fetch(vaultUrl(cfg, path), {
		method: 'PUT',
		headers: { ...authHeaders(cfg), 'Content-Type': 'text/markdown' },
		body: markdown,
	});
	if (!res.ok) throw new Error(`Obsidian PUT ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** Create or overwrite a binary attachment. */
export async function putBinary(
	cfg: ObsidianRestConfig,
	path: string,
	bytes: Uint8Array,
	mimeType: string,
): Promise<void> {
	const res = await fetch(vaultUrl(cfg, path), {
		method: 'PUT',
		headers: { ...authHeaders(cfg), 'Content-Type': mimeType },
		body: bytes,
	});
	if (!res.ok) throw new Error(`Obsidian PUT(bin) ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
