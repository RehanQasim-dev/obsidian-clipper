// Fetches and parses a YouTube watch page's caption track into timestamped cues
// for the live transcript-annotation panel. Lazy-loaded by the transcript panel,
// so none of this touches non-YouTube pages.
//
// Source & transport mirror upstream Defuddle's reader-mode extractor: track
// list comes from the inline player response (read from the bootstrap <script>)
// or the unofficial innertube `/player` API (iOS/WEB client, no key); the caption
// track itself is fetched as plain XML. All network requests go through the
// background `fetchProxy` (same path reader mode uses) — the service worker has
// the extension's host permissions, whereas a content-script fetch on youtube.com
// can be blocked by the page's connect-src CSP.

import browser from '../browser-polyfill';
import Defuddle from 'defuddle';

// Route a request through the background fetch proxy; returns the response body
// text (or null on failure). Falls back to a direct fetch if the proxy is absent.
async function proxyFetch(
	url: string,
	options?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<string | null> {
	try {
		const resp = await browser.runtime.sendMessage({ action: 'fetchProxy', url, options }) as
			{ ok?: boolean; text?: string } | undefined;
		if (resp && resp.ok && typeof resp.text === 'string') return resp.text;
		if (resp && typeof resp.text === 'string') return null; // reached server, not ok
	} catch { /* fall through to direct fetch */ }
	try {
		const res = await fetch(url, options as RequestInit);
		return res.ok ? await res.text() : null;
	} catch {
		return null;
	}
}

export interface TranscriptCue {
	index: number;
	start: number; // seconds
	end: number;   // seconds
	text: string;
}

// A readable paragraph: a run of consecutive cues. The cues are retained so a
// text selection still resolves to per-cue time ranges and offsets.
export interface TranscriptParagraph {
	cues: TranscriptCue[];
}

export interface TranscriptTrack {
	languageCode: string;
	name: string;
	baseUrl: string;
	isASR: boolean;
}

export interface LoadedTranscript {
	videoId: string;
	languageCode: string;
	tracks: TranscriptTrack[];
	cues: TranscriptCue[];
	paragraphs: TranscriptParagraph[];
}

// --- Session caches (cleared on full page reload) ----------------------------
const tracksCache = new Map<string, TranscriptTrack[]>();          // videoId → tracks
const transcriptCache = new Map<string, { cues: TranscriptCue[]; paragraphs: TranscriptParagraph[] }>();
const sessionLangPref = new Map<string, string>();                 // videoId → chosen languageCode

export function getSessionLang(videoId: string): string | undefined {
	return sessionLangPref.get(videoId);
}
export function setSessionLang(videoId: string, lang: string): void {
	sessionLangPref.set(videoId, lang);
}

// --- Track discovery ---------------------------------------------------------

function trackName(t: any): string {
	return t?.name?.simpleText || t?.name?.runs?.map((r: any) => r.text).join('') || t?.languageCode || '';
}

function parseTracksFromCaptionsObj(captions: any): TranscriptTrack[] {
	const list = captions?.playerCaptionsTracklistRenderer?.captionTracks;
	if (!Array.isArray(list)) return [];
	return list
		.filter((t: any) => t?.baseUrl)
		.map((t: any) => ({
			languageCode: t.languageCode || '',
			name: trackName(t),
			baseUrl: t.baseUrl as string,
			isASR: t.kind === 'asr',
		}));
}

// Pull the `captionTracks` array straight out of any inline script. More robust
// than parsing the whole player response: it tolerates whatever assignment wraps
// it and never bails on an unrelated script that merely mentions the variable.
function tracksFromInlineScript(_videoId: string): TranscriptTrack[] | null {
	const scripts = Array.from(document.querySelectorAll('script'));
	for (const s of scripts) {
		const txt = s.textContent || '';
		const key = '"captionTracks":';
		const i = txt.indexOf(key);
		if (i < 0) continue;
		const arrStart = txt.indexOf('[', i + key.length);
		if (arrStart < 0) continue;
		const arr = sliceBalanced(txt, arrStart, '[', ']');
		if (!arr) continue;
		try {
			const list = JSON.parse(arr);
			const tracks = parseTracksFromCaptionsObj({ playerCaptionsTracklistRenderer: { captionTracks: list } });
			if (tracks.length) return tracks;
		} catch { /* try next script */ }
	}
	return null;
}

// Extract the first balanced open/close-delimited slice starting at `start`,
// honoring string literals so braces/brackets inside strings don't miscount.
function sliceBalanced(s: string, start: number, open: string, close: string): string | null {
	let depth = 0, inStr = false, esc = false;
	for (let i = start; i < s.length; i++) {
		const c = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === '\\') esc = true;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === open) depth++;
		else if (c === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
	}
	return null;
}

// Unofficial InnerTube player API (no API key needed). Mirrors upstream
// Defuddle's reader-mode extractor: try the iOS client first (it doesn't require
// the special User-Agent header that the Android client needs — and UA is a
// forbidden header in extensions), then fall back to the WEB client.
const INNERTUBE_PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_IOS_CONTEXT = { client: { clientName: 'IOS', clientVersion: '20.10.3' } };
const INNERTUBE_WEB_CONTEXT = { client: { clientName: 'WEB', clientVersion: '2.20240101.00.00' } };

async function innertubePlayer(videoId: string, context: unknown): Promise<any | null> {
	const text = await proxyFetch(INNERTUBE_PLAYER_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ context, videoId }),
	});
	if (!text) return null;
	try { return JSON.parse(text); } catch { return null; }
}

async function tracksFromInnertube(videoId: string): Promise<TranscriptTrack[]> {
	for (const ctx of [INNERTUBE_IOS_CONTEXT, INNERTUBE_WEB_CONTEXT]) {
		const data = await innertubePlayer(videoId, ctx);
		const tracks = parseTracksFromCaptionsObj(data?.captions);
		if (tracks.length) return tracks;
	}
	return [];
}

export async function getTranscriptTracks(videoId: string): Promise<TranscriptTrack[]> {
	if (tracksCache.has(videoId)) return tracksCache.get(videoId)!;
	let tracks = tracksFromInlineScript(videoId) || [];
	let source = 'inline-script';
	if (tracks.length === 0) { tracks = await tracksFromInnertube(videoId); source = 'innertube'; }
	console.debug('[obsidian-clipper] transcript tracks:', tracks.length, 'via', source,
		tracks.map(t => `${t.languageCode}${t.isASR ? '(asr)' : ''}`));
	tracksCache.set(videoId, tracks);
	return tracks;
}

// Auto-pick order: session preference → English (non-ASR preferred) → first.
export function pickTrack(tracks: TranscriptTrack[], videoId: string): TranscriptTrack | null {
	if (tracks.length === 0) return null;
	const pref = sessionLangPref.get(videoId);
	if (pref) {
		const m = tracks.find(t => t.languageCode === pref);
		if (m) return m;
	}
	const en = tracks.filter(t => t.languageCode.toLowerCase().startsWith('en'));
	if (en.length) return en.find(t => !t.isASR) || en[0];
	return tracks.find(t => !t.isASR) || tracks[0];
}

// --- Cue fetching & parsing --------------------------------------------------

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Parse YouTube's caption XML. Default format is <text start="s" dur="s">…</text>;
// srv3 is <p t="ms" d="ms"><s>word</s>…</p>. One line = one cue.
function parseCuesXml(xml: string): TranscriptCue[] {
	const cues: TranscriptCue[] = [];
	let m: RegExpExecArray | null;

	const pRe = /<p\s+t="(\d+)"(?:[^>]*?\sd="(\d+)")?[^>]*>([\s\S]*?)<\/p>/g;
	while ((m = pRe.exec(xml)) !== null) {
		const start = parseInt(m[1], 10) / 1000;
		const dur = m[2] ? parseInt(m[2], 10) / 1000 : 0;
		const inner = m[3];
		let text = '';
		const sRe = /<s[^>]*>([^<]*)<\/s>/g;
		let s: RegExpExecArray | null;
		while ((s = sRe.exec(inner)) !== null) text += s[1];
		if (!text) text = inner.replace(/<[^>]+>/g, '');
		text = decodeEntities(text.replace(/\n/g, ' ').replace(/\s{2,}/g, ' ')).trim();
		if (text) cues.push({ index: cues.length, start, end: start + dur, text });
	}
	if (cues.length) return cues;

	const tRe = /<text\s+start="([^"]*)"(?:[^>]*?\sdur="([^"]*)")?[^>]*>([\s\S]*?)<\/text>/g;
	while ((m = tRe.exec(xml)) !== null) {
		const start = parseFloat(m[1]) || 0;
		const dur = m[2] ? (parseFloat(m[2]) || 0) : 0;
		const text = decodeEntities(m[3].replace(/<[^>]+>/g, '').replace(/\n/g, ' ').replace(/\s{2,}/g, ' ')).trim();
		if (text) cues.push({ index: cues.length, start, end: start + dur, text });
	}
	return cues;
}

async function fetchCues(track: TranscriptTrack): Promise<TranscriptCue[]> {
	// Fetch the caption track as XML (the default, like upstream Defuddle). The
	// json3 format YouTube now frequently returns empty without a session token.
	const xml = await proxyFetch(track.baseUrl);
	if (xml == null) throw new Error('timedtext fetch failed');
	const cues = parseCuesXml(xml);
	console.debug('[obsidian-clipper] transcript cues fetched:', cues.length, 'cues for', track.languageCode);
	return cues;
}

// Group consecutive cues into readable paragraphs: break on a sentence end, a
// noticeable speech gap, or after enough text so paragraphs stay digestible.
const SENT_END = /[.!?。！？]["')\]]?$/;
function groupParagraphs(cues: TranscriptCue[]): TranscriptParagraph[] {
	const paras: TranscriptParagraph[] = [];
	let cur: TranscriptCue[] = [];
	let chars = 0;
	for (let i = 0; i < cues.length; i++) {
		const c = cues[i];
		cur.push(c);
		chars += c.text.length + 1;
		const next = cues[i + 1];
		const gap = next ? next.start - c.end : 0;
		const endsSentence = SENT_END.test(c.text);
		if ((endsSentence && chars >= 160) || chars >= 360 || gap > 2.5 || !next) {
			paras.push({ cues: cur });
			cur = [];
			chars = 0;
		}
	}
	if (cur.length) paras.push({ cues: cur });
	return paras;
}

// Primary extraction path: reuse upstream Defuddle (the exact code reader mode
// uses to produce `{{transcript}}`). Each `.transcript-segment` it emits — a
// readable, already-grouped block with a `data-timestamp` — becomes one cue.
async function cuesViaDefuddle(lang: string): Promise<TranscriptCue[] | null> {
	try {
		const d = new Defuddle(document, { url: location.href, language: lang });
		const timeout = new Promise<null>(res => setTimeout(() => res(null), 12000));
		const result = await Promise.race([d.parseAsync(), timeout]) as { content?: string } | null;
		if (!result || !result.content) return null;
		const doc = new DOMParser().parseFromString(result.content, 'text/html');
		const segs = Array.from(doc.querySelectorAll('.transcript-segment'));
		const cues: TranscriptCue[] = [];
		for (const seg of segs) {
			const tsEl = seg.querySelector('.timestamp');
			const start = tsEl ? parseFloat(tsEl.getAttribute('data-timestamp') || '') : NaN;
			if (isNaN(start)) continue;
			let text = seg.textContent || '';
			if (tsEl?.textContent) text = text.replace(tsEl.textContent, '');
			text = text.replace(/^\s*·\s*/, '').replace(/\s+/g, ' ').trim();
			if (text) cues.push({ index: cues.length, start, end: start, text });
		}
		for (let i = 0; i < cues.length; i++) {
			cues[i].index = i;
			cues[i].end = i + 1 < cues.length ? cues[i + 1].start : cues[i].start + 5;
		}
		console.debug('[obsidian-clipper] transcript via defuddle:', cues.length, 'segments');
		return cues.length ? cues : null;
	} catch (err) {
		console.warn('[obsidian-clipper] defuddle transcript failed:', err);
		return null;
	}
}

// Load (and cache) the transcript for a video in a given language. Returns null
// when the video has no captions.
export async function loadTranscript(videoId: string, lang?: string): Promise<LoadedTranscript | null> {
	// Track list is best-effort, only used to populate the language picker.
	const tracks = await getTranscriptTracks(videoId).catch(() => [] as TranscriptTrack[]);
	const chosenLang = lang || sessionLangPref.get(videoId) || pickTrack(tracks, videoId)?.languageCode || 'en';

	const cacheKey = `${videoId}:${chosenLang}`;
	const cached = transcriptCache.get(cacheKey);
	if (cached) return { videoId, languageCode: chosenLang, tracks, ...cached };

	// Primary: Defuddle (already grouped into readable segments → one cue each).
	let cues = await cuesViaDefuddle(chosenLang);
	let paragraphs: TranscriptParagraph[] = cues ? cues.map(c => ({ cues: [c] })) : [];

	// Fallback: our own caption-track discovery + XML fetch (finer-grained cues).
	if ((!cues || cues.length === 0) && tracks.length) {
		const track = (lang && tracks.find(t => t.languageCode === lang)) || pickTrack(tracks, videoId);
		if (track) {
			try {
				cues = await fetchCues(track);
				paragraphs = groupParagraphs(cues);
			} catch (err) {
				console.warn('[obsidian-clipper] transcript cue fetch failed:', err);
			}
		}
	}
	if (!cues || cues.length === 0) return null;

	transcriptCache.set(cacheKey, { cues, paragraphs });
	return { videoId, languageCode: chosenLang, tracks, cues, paragraphs };
}
