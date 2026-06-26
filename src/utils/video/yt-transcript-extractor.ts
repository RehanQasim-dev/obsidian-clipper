// Vendored YouTube transcript extractor — adapted from
// `node_modules/defuddle/dist/extractors/youtube.js`. We use Defuddle's proven
// fetch + DOM-scrape pipeline verbatim, but stop *before* its grouping step
// and hand the raw per-line segments back to the caller. The transcript panel
// then runs its own semantic chunker on those segments, so each emitted chunk
// keeps a real per-cue timestamp.
//
// Sync with upstream notes:
//   - Selectors, Innertube contexts, headers, click flows match Defuddle's
//     youtube.js byte-for-byte except where TypeScript demanded type fixes.
//   - We omitted Defuddle's grouping, chapter extraction, title/channel/video
//     metadata, and `buildResult` — none of those are needed for chunked
//     panel rendering.
//   - When updating Defuddle, diff this file against the new youtube.js and
//     port any fetch/scrape changes.

export interface RawSegment {
	start: number;  // seconds
	text: string;
}

interface CaptionTrack {
	languageCode: string;
	baseUrl: string;
	kind?: string;
	name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}

const FETCH_TIMEOUT_MS = 4000;

const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_CONTEXT = { client: { clientName: 'ANDROID', clientVersion: INNERTUBE_CLIENT_VERSION } };
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;
const INNERTUBE_IOS_CONTEXT = { client: { clientName: 'IOS', clientVersion: '20.10.3' } };
const INNERTUBE_WEB_CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } };

const DESKTOP_TRANSCRIPT_SELECTORS = {
	segments: 'ytd-transcript-segment-renderer',
	timestamp: '.segment-timestamp',
	text: '.segment-text',
};
const MOBILE_TRANSCRIPT_SELECTORS = {
	segments: 'transcript-segment-view-model',
	timestamp: '.ytwTranscriptSegmentViewModelTimestamp',
	text: 'span.yt-core-attributed-string',
};

function getVideoIdFromUrl(url: string): string {
	const u = new URL(url);
	if (u.hostname === 'youtu.be') return u.pathname.slice(1);
	if (u.pathname.includes('/shorts/')) return u.pathname.split('/shorts/')[1].split('/')[0];
	return new URLSearchParams(u.search).get('v') || '';
}

function parseTimestamp(ts: string): number | null {
	const parts = ts.split(':').map(Number);
	if (parts.some(isNaN)) return null;
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return null;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Pull a top-level JS global object literal out of an inline script tag.
function parseInlineJson(doc: Document, globalName: string): any {
	const scripts = Array.from(doc.querySelectorAll('script'));
	for (const script of scripts) {
		const text = script.textContent || '';
		if (!text.includes(globalName)) continue;
		const start = text.indexOf('{', text.indexOf(globalName));
		if (start === -1) continue;
		let depth = 0;
		for (let i = start; i < text.length; i++) {
			const c = text[i];
			if (c === '{') depth++;
			else if (c === '}') {
				depth--;
				if (depth === 0) {
					try { return JSON.parse(text.slice(start, i + 1)); }
					catch { break; }
				}
			}
		}
	}
	return null;
}

function getValidatedPlayerResponse(doc: Document, videoId: string): any {
	if (!videoId) return null;
	const data = parseInlineJson(doc, 'ytInitialPlayerResponse');
	if (!data) return null;
	const detail = data.videoDetails?.videoId;
	const micro = data.microformat?.playerMicroformatRenderer?.externalVideoId;
	return (detail === videoId || micro === videoId) ? data : null;
}

function getCaptionTracks(playerData: any): CaptionTrack[] {
	const list = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
	return Array.isArray(list) ? list : [];
}

function normalizeLang(code?: string): string {
	return (code || '').toLowerCase().replace('_', '-');
}

function findPreferredCaptionTrack(tracks: CaptionTrack[], preferredLang: string): CaptionTrack | undefined {
	const norm = normalizeLang(preferredLang);
	if (!norm) return undefined;
	const base = norm.split('-')[0];
	const annotated = tracks.map(t => ({ t, code: normalizeLang(t.languageCode) }));
	const findBest = (pred: (x: { t: CaptionTrack; code: string }) => boolean): CaptionTrack | undefined => {
		const matches = annotated.filter(pred);
		return (matches.find(({ t }) => t.kind !== 'asr') ?? matches[0])?.t;
	};
	return findBest(({ code }) => code === norm)
		?? findBest(({ code }) => code === base)
		?? findBest(({ code }) => code.split('-')[0] === base);
}

function pickCaptionTrack(tracks: CaptionTrack[], preferredLang: string | undefined): CaptionTrack | undefined {
	if (preferredLang) {
		const m = findPreferredCaptionTrack(tracks, preferredLang);
		if (m) return m;
	}
	const nonAsr = tracks.filter(t => t.kind !== 'asr');
	const pool = nonAsr.length > 0 ? nonAsr : tracks;
	return pool.find(t => t.languageCode === 'en') || pool[0];
}

function getInlineCaptionTrack(doc: Document, videoId: string, lang: string | undefined): CaptionTrack | undefined {
	const data = getValidatedPlayerResponse(doc, videoId);
	const tracks = getCaptionTracks(data);
	if (tracks.length === 0) return undefined;
	const track = pickCaptionTrack(tracks, lang);
	return track?.baseUrl ? track : undefined;
}

async function fetchPlayerData(videoId: string, lang?: string): Promise<any> {
	const tryClient = async (context: unknown, extraHeaders: Record<string, string> = {}): Promise<any> => {
		try {
			const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
			if (lang) headers['Accept-Language'] = lang;
			const resp = await fetch(INNERTUBE_API_URL, {
				method: 'POST', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				body: JSON.stringify({ context, videoId }),
			});
			if (!resp.ok) return null;
			const data = await resp.json();
			return getCaptionTracks(data).length > 0 ? data : null;
		} catch { return null; }
	};
	// iOS first (doesn't need a special UA — forbidden header in extensions),
	// then Android (needs UA), then WEB.
	return (await tryClient(INNERTUBE_IOS_CONTEXT))
		|| (await tryClient(INNERTUBE_CONTEXT, { 'User-Agent': INNERTUBE_USER_AGENT }))
		|| (await tryClient(INNERTUBE_WEB_CONTEXT))
		|| null;
}

function parseTranscriptXml(xml: string): RawSegment[] {
	const segments: RawSegment[] = [];
	// srv3: <p t="ms" d="ms"><s>word</s>…</p>
	const pRe = /<p\s+t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
	let m: RegExpExecArray | null;
	while ((m = pRe.exec(xml)) !== null) {
		const startMs = parseInt(m[1], 10);
		const inner = m[2];
		let text = '';
		const sRe = /<s[^>]*>([^<]*)<\/s>/g;
		let s: RegExpExecArray | null;
		while ((s = sRe.exec(inner)) !== null) text += s[1];
		if (!text) text = inner.replace(/<[^>]+>/g, '');
		text = decodeEntities(text.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ')).trim();
		if (text) segments.push({ start: startMs / 1000, text });
	}
	if (segments.length) return segments;
	// Simple format: <text start="s" dur="s">…</text>
	const tRe = /<text\s+start="([^"]*)"[^>]*>([\s\S]*?)<\/text>/g;
	while ((m = tRe.exec(xml)) !== null) {
		const start = parseFloat(m[1]);
		const text = decodeEntities(m[2].replace(/<[^>]+>/g, '').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ')).trim();
		if (text) segments.push({ start, text });
	}
	return segments;
}

async function fetchCaptionXml(track: CaptionTrack, lang?: string): Promise<RawSegment[] | null> {
	try {
		const u = new URL(track.baseUrl);
		if (!u.hostname.endsWith('.youtube.com')) return null;
		const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0' };
		if (lang) headers['Accept-Language'] = lang;
		const resp = await fetch(track.baseUrl, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		if (!resp.ok) return null;
		const xml = await resp.text().catch(() => '');
		if (!xml) return null;
		const segs = parseTranscriptXml(xml);
		return segs.length ? segs : null;
	} catch { return null; }
}

async function fetchTranscript(doc: Document, videoId: string, lang?: string): Promise<RawSegment[] | null> {
	try {
		const inlineTrack = getInlineCaptionTrack(doc, videoId, lang);
		const inlinePromise = inlineTrack ? fetchCaptionXml(inlineTrack, lang) : Promise.resolve(null);
		const playerData = await fetchPlayerData(videoId, lang);
		const apiTrack = playerData ? pickCaptionTrack(getCaptionTracks(playerData), lang) : undefined;
		const apiPromise = apiTrack?.baseUrl && apiTrack.baseUrl !== inlineTrack?.baseUrl
			? fetchCaptionXml(apiTrack, lang) : Promise.resolve(null);
		const apiResult = await apiPromise;
		if (apiResult && apiResult.length) return apiResult;
		const inlineResult = await inlinePromise;
		return inlineResult && inlineResult.length ? inlineResult : null;
	} catch { return null; }
}

// --- DOM scrape path ---------------------------------------------------------

function getTranscriptContainer(doc: Document): Element | null {
	const desktop = doc.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] #segments-container');
	if (desktop) return desktop;
	return doc.querySelector('ytm-macro-markers-list-renderer .ytm-macro-markers-list-container');
}

function getTranscriptSelectors(container: Element): typeof DESKTOP_TRANSCRIPT_SELECTORS | typeof MOBILE_TRANSCRIPT_SELECTORS | undefined {
	if (container.querySelectorAll(DESKTOP_TRANSCRIPT_SELECTORS.segments).length > 0) return DESKTOP_TRANSCRIPT_SELECTORS;
	if (container.querySelectorAll(MOBILE_TRANSCRIPT_SELECTORS.segments).length > 0) return MOBILE_TRANSCRIPT_SELECTORS;
	return undefined;
}

function buildSegmentsFromContainer(container: Element): RawSegment[] {
	if (container.children.length === 0) return [];
	const selectors = getTranscriptSelectors(container);
	if (!selectors) return [];
	const segments: RawSegment[] = [];
	const segEls = container.querySelectorAll(selectors.segments);
	for (const seg of Array.from(segEls)) {
		const tsEl = seg.querySelector(selectors.timestamp);
		const txtEl = seg.querySelector(selectors.text);
		if (!tsEl || !txtEl) continue;
		const timeStr = (tsEl.textContent || '').trim();
		const text = (txtEl.textContent || '').trim();
		if (!text) continue;
		const start = parseTimestamp(timeStr);
		if (start !== null) segments.push({ start, text });
	}
	return segments;
}

function pollFor<T>(predicate: () => T | null, maxAttempts = 20, intervalMs = 250): Promise<T | null> {
	return new Promise(resolve => {
		let attempts = 0;
		const check = () => {
			const r = predicate();
			if (r) resolve(r);
			else if (attempts++ < maxAttempts) setTimeout(check, intervalMs);
			else resolve(null);
		};
		check();
	});
}

function waitForTranscriptContainer(doc: Document): Promise<Element | null> {
	return pollFor(() => {
		const c = getTranscriptContainer(doc);
		return c && c.children.length > 0 ? c : null;
	});
}

function waitForTranscriptSegments(doc: Document): Promise<Element | null> {
	return pollFor(() => {
		const c = getTranscriptContainer(doc);
		if (!c || c.children.length === 0) return null;
		return c.querySelectorAll(MOBILE_TRANSCRIPT_SELECTORS.segments).length > 0 ? c : null;
	});
}

function waitForElement(doc: Document, selector: string): Promise<Element | null> {
	return pollFor(() => doc.querySelector(selector));
}

function isMobileYoutube(doc: Document): boolean {
	return !!doc.querySelector('ytm-slim-video-metadata-section-renderer');
}

function canOpenTranscriptPanel(doc: Document): boolean {
	return typeof (doc.defaultView as any)?.MutationObserver === 'function';
}

async function openMobileTranscriptPanel(doc: Document): Promise<RawSegment[] | null> {
	try {
		(doc.querySelector('button[aria-label="Show more"]') as HTMLElement | null)?.click();
		const viewAll = await waitForElement(doc, 'button[aria-label="View all"]');
		if (!viewAll) return null;
		(viewAll as HTMLElement).click();
		const timeline = await waitForElement(doc, 'button[aria-label="Timeline"]');
		if (!timeline) return null;
		(timeline as HTMLElement).click();
		const container = await waitForTranscriptSegments(doc);
		if (!container) return null;
		return buildSegmentsFromContainer(container);
	} catch { return null; }
}

async function extractTranscriptFromOpenedDom(doc: Document): Promise<RawSegment[] | null> {
	try {
		if (!canOpenTranscriptPanel(doc)) return null;
		if (isMobileYoutube(doc)) return openMobileTranscriptPanel(doc);
		const btn = doc.querySelector('ytd-video-description-transcript-section-renderer button');
		if (!btn) return null;
		(btn as HTMLElement).click();
		const container = await waitForTranscriptContainer(doc);
		if (!container) return null;
		return buildSegmentsFromContainer(container);
	} catch { return null; }
}

function extractTranscriptFromExistingDom(doc: Document): RawSegment[] | null {
	const container = getTranscriptContainer(doc);
	if (!container) return null;
	const segs = buildSegmentsFromContainer(container);
	return segs.length ? segs : null;
}

// --- Public entry point -----------------------------------------------------

export interface ExtractOptions {
	doc?: Document;
	url?: string;
	language?: string;
}

export async function extractRawSegments(opts: ExtractOptions = {}): Promise<RawSegment[] | null> {
	const doc = opts.doc || document;
	const url = opts.url || location.href;
	const lang = opts.language;
	const videoId = getVideoIdFromUrl(url);
	if (!videoId) return null;

	// Path A: panel is already open from a prior interaction.
	const existing = extractTranscriptFromExistingDom(doc);
	if (existing && existing.length) return existing;

	// Path B: fetch-based (inline + Innertube, parallel — Defuddle's strategy).
	const fetched = await fetchTranscript(doc, videoId, lang);
	if (fetched && fetched.length) return fetched;

	// Path C: open the panel and scrape (handles mobile flow internally).
	const opened = await extractTranscriptFromOpenedDom(doc);
	if (opened && opened.length) return opened;

	return null;
}
