import browser from './browser-polyfill';
import { sanitizeFileName } from './string-utils';
import {
	getConfig,
	setConfig,
	ObsidianRestConfig,
	ping,
	getNote,
	putNote,
	putBinary,
} from './obsidian-rest';
import {
	buildPageBlock,
	buildVideoBlock,
	assembleNote,
} from './obsidian-export';

// Background orchestrator for pushing annotations into Obsidian via the Local
// REST API. Live on change: edits enqueue their normalized URL; a debounced flush
// writes one note per page/video. When Obsidian/the plugin is offline the queue is
// kept intact and retried (on the sync alarm and on startup), so pending changes
// flush automatically once it comes online.

const QUEUE_KEY = 'obsidian_sync_queue';
const STATUS_KEY = 'obsidian_sync_status';
const PATHMAP_KEY = 'obsidian_path_map';

export interface ObsidianSyncStatus {
	enabled: boolean;
	syncing?: boolean;
	offline?: boolean;
	lastSyncedAt?: number;
	lastError?: string;
	pending: number;
}

interface HighlightStored {
	url: string;
	title?: string;
	highlights: { id: string; content: string; notes?: string[]; color?: string; groupId?: string }[];
}
interface VideoStored {
	url: string;
	videoId: string;
	title?: string;
	items: {
		id: string;
		kind: 'frame' | 'note' | 'transcript';
		videoTime: number;
		timeEnd?: number;
		quote?: string;
		color?: string;
		notes?: string[];
		frame?: { dataUrl?: string; w?: number; h?: number };
	}[];
}

// --- small helpers -----------------------------------------------------------

async function getQueue(): Promise<string[]> {
	return ((await browser.storage.local.get(QUEUE_KEY))[QUEUE_KEY] as string[]) || [];
}
async function setQueue(urls: string[]): Promise<void> {
	await browser.storage.local.set({ [QUEUE_KEY]: urls });
}
async function getPathMap(): Promise<Record<string, string>> {
	return ((await browser.storage.local.get(PATHMAP_KEY))[PATHMAP_KEY] as Record<string, string>) || {};
}

async function setStatus(patch: Partial<ObsidianSyncStatus>): Promise<void> {
	const cfg = await getConfig();
	const cur = ((await browser.storage.local.get(STATUS_KEY))[STATUS_KEY] as ObsidianSyncStatus) || {
		enabled: cfg.enabled,
		pending: 0,
	};
	await browser.storage.local.set({ [STATUS_KEY]: { ...cur, ...patch, enabled: cfg.enabled } });
}

export async function getStatus(): Promise<ObsidianSyncStatus> {
	const cfg = await getConfig();
	const stored = (await browser.storage.local.get(STATUS_KEY))[STATUS_KEY] as ObsidianSyncStatus | undefined;
	const queue = await getQueue();
	return { enabled: cfg.enabled, pending: queue.length, ...(stored || {}), };
}

function shortHash(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36).slice(0, 6);
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
	const b64 = dataUrl.split(',')[1] || '';
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function hostnameOf(url: string): string {
	try {
		return new URL(url).hostname || 'web';
	} catch {
		return 'web';
	}
}

// --- path resolution (stable per URL) ----------------------------------------

async function resolvePath(cfg: ObsidianRestConfig, url: string, title: string): Promise<string> {
	const map = await getPathMap();
	if (map[url]) return map[url];

	const host = hostnameOf(url);
	const name = sanitizeFileName(title) || sanitizeFileName(host) || 'note';
	let candidate = `${cfg.folder}/${host}/${name}.md`;
	const taken = new Set(Object.values(map));
	if (taken.has(candidate)) candidate = `${cfg.folder}/${host}/${name}-${shortHash(url)}.md`;

	map[url] = candidate;
	await browser.storage.local.set({ [PATHMAP_KEY]: map });
	return candidate;
}

// --- the one-page write ------------------------------------------------------

async function processUrl(cfg: ObsidianRestConfig, url: string): Promise<void> {
	const store = await browser.storage.local.get(['highlights', 'video_annotations']);
	const hl = (store.highlights as Record<string, HighlightStored> | undefined)?.[url];
	const vid = (store.video_annotations as Record<string, VideoStored> | undefined)?.[url];

	const hasHighlights = !!hl?.highlights?.length;
	const hasVideo = !!vid?.items?.length;
	if (!hasHighlights && !hasVideo) return; // nothing to write (leave any existing note intact)

	const title = vid?.title || hl?.title || hostnameOf(url);
	const blocks: string[] = [];
	const attachments: { filename: string; dataUrl: string }[] = [];

	if (hasHighlights) blocks.push(buildPageBlock(title, url, hl!.highlights));
	if (hasVideo) {
		const v = buildVideoBlock(title, url, vid!.videoId, vid!.items);
		blocks.push(v.markdown);
		attachments.push(...v.attachments);
	}

	// Upload frame images first so the embeds resolve.
	for (const att of attachments) {
		try {
			await putBinary(cfg, `${cfg.folder}/Attachments/${att.filename}`, dataUrlToBytes(att.dataUrl), 'image/jpeg');
		} catch {
			/* image upload failed — note still written, embed will show as missing */
		}
	}

	const path = await resolvePath(cfg, url, title);
	const props: Record<string, string> = {
		source: url,
		domain: hostnameOf(url),
		type: hasVideo ? 'video' : 'page',
		captured: new Date().toISOString().slice(0, 10),
		tags: hasVideo ? 'clippings, clipper/video' : 'clippings',
	};
	const existing = await getNote(cfg, path);
	await putNote(cfg, path, assembleNote(existing, blocks.join('\n\n---\n\n'), props));
}

// --- CSS snippet (highlight colors), pushed once -----------------------------

const HIGHLIGHT_CSS = `/* Generated by Obsidian Web Clipper — maps highlight colors. Enable under Settings → Appearance → CSS snippets. */
mark.hl-yellow { background: #ffe066; color: inherit; }
mark.hl-red { background: #ff9a9a; color: inherit; }
mark.hl-green { background: #9be19b; color: inherit; }
`;

async function pushCssOnce(cfg: ObsidianRestConfig): Promise<void> {
	if (cfg.cssPushed) return;
	try {
		await putNote(cfg, '.obsidian/snippets/clipper-highlights.css', HIGHLIGHT_CSS);
		await setConfig({ cssPushed: true });
	} catch {
		/* best-effort; some setups disallow writing under .obsidian */
	}
}

// --- queue + flush -----------------------------------------------------------

export async function markDirty(urls: string[]): Promise<void> {
	const cfg = await getConfig();
	if (!cfg.enabled || !urls.length) return;
	const queue = new Set(await getQueue());
	for (const u of urls) queue.add(u);
	await setQueue([...queue]);
}

/** Enqueue every page/video that has annotations (the "Sync all" button). */
export async function enqueueAll(): Promise<void> {
	const store = await browser.storage.local.get(['highlights', 'video_annotations']);
	const urls = new Set<string>([
		...Object.keys((store.highlights as object) || {}),
		...Object.keys((store.video_annotations as object) || {}),
	]);
	const queue = new Set(await getQueue());
	for (const u of urls) queue.add(u);
	await setQueue([...queue]);
}

let running: Promise<void> | null = null;

/**
 * Drain the queue to Obsidian. If unreachable, the queue is kept for a later
 * retry. Coalesces concurrent calls.
 */
export async function flush(): Promise<void> {
	if (running) return running;
	running = doFlush().finally(() => {
		running = null;
	});
	return running;
}

async function doFlush(): Promise<void> {
	const cfg = await getConfig();
	if (!cfg.enabled) return;
	const queue = await getQueue();
	if (!queue.length) return;

	await setStatus({ syncing: true, offline: false });
	try {
		if (!(await ping(cfg))) {
			// Offline — keep the queue; this is not an error, just deferred.
			await setStatus({ syncing: false, offline: true, pending: queue.length, lastError: undefined });
			return;
		}
	} catch (err) {
		// Reachable but unauthorized (bad key) — surface it.
		await setStatus({ syncing: false, offline: false, pending: queue.length, lastError: err instanceof Error ? err.message : String(err) });
		return;
	}

	await pushCssOnce(cfg);

	const remaining: string[] = [];
	let lastError: string | undefined;
	for (const url of queue) {
		try {
			await processUrl(cfg, url);
		} catch (err) {
			remaining.push(url);
			lastError = err instanceof Error ? err.message : String(err);
		}
	}
	await setQueue(remaining);
	await setStatus({
		syncing: false,
		offline: false,
		pending: remaining.length,
		lastError,
		...(remaining.length === 0 ? { lastSyncedAt: Date.now() } : {}),
	});
}

/** Test connectivity for the settings UI; returns a human-readable result. */
export async function testConnection(): Promise<{ ok: boolean; message: string }> {
	const cfg = await getConfig();
	try {
		const ok = await ping(cfg);
		return ok
			? { ok: true, message: 'Connected to Obsidian.' }
			: { ok: false, message: 'Obsidian not reachable. Is the app running with the Local REST API (insecure HTTP) server enabled?' };
	} catch (err) {
		return { ok: false, message: err instanceof Error ? err.message : String(err) };
	}
}
