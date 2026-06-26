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
import { extractRawSegments } from './yt-transcript-extractor';

// Route a request through the background fetch proxy; returns the response body
// text (or null on failure). Falls back to a direct fetch if the proxy is absent.
async function proxyFetch(
	url: string,
	options?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<string | null> {
	try {
		const resp = await browser.runtime.sendMessage({ action: 'fetchProxy', url, options }) as
			{ ok?: boolean; status?: number; text?: string } | undefined;
		if (resp && resp.ok && typeof resp.text === 'string') return resp.text;
		if (resp && typeof resp.text === 'string') {
			console.debug('[obsidian-clipper] proxyFetch non-ok:', resp.status, url.slice(0, 120));
			return null;
		}
	} catch { /* fall through to direct fetch */ }
	try {
		const res = await fetch(url, options as RequestInit);
		if (!res.ok) console.debug('[obsidian-clipper] direct fetch non-ok:', res.status, url.slice(0, 120));
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


// Semantic chunker for the transcript panel. Operates on raw XML caption cues
// (each cue has a real per-cue `start`), so every emitted chunk's timestamp is
// a real cue start — no proportional estimation. Defuddle does its own grouping
// optimized for reader-mode paragraphs; this one is tuned for clickable,
// navigable chunks: shorter, uniform, and broken at the most semantic point we
// can find without leaving sub-word artifacts.
//
// Priority of break signals:
//   Hard (always break before the incoming cue):
//     - long speech pause (gap ≥ LONG_PAUSE_S)
//     - speaker-change marker at the start of the cue (`>>` or `-`)
//   Preferred (break here once chunk is past SOFT_MIN_CHARS):
//     - sentence end on current cue (.!? plus CJK punct)
//     - discourse marker (So/Now/Okay/…) at the start of the next cue
//   Acceptable (break here once chunk is past SOFT_TARGET_CHARS):
//     - comma / semicolon / em-dash on current cue
//   Last resort (break unconditionally when chunk reaches HARD_MAX_CHARS):
//     - at the current cue boundary; never mid-word, since cues never split

// Constants used by the fallback chunker (when Defuddle is unavailable).
const SENT_END = /[.!?。！？]["')\]’”]?\s*$/;
const TRANSCRIPT_GROUP_GAP_SECONDS = 20;
const TRANSCRIPT_MAX_GROUP_SECONDS = 30;

// --- Defuddle-paragraph extraction ------------------------------------------
// Run Defuddle's full parse pipeline and pull out its grouped paragraph text +
// the (approximate) start timestamp of each paragraph. We use these *exact*
// paragraph texts for display; alignment maps our fine-grained cues onto them.
interface DefuddlePara { start: number; text: string; }
async function fetchDefuddleParagraphs(lang: string): Promise<DefuddlePara[]> {
	try {
		const d = new Defuddle(document, { url: location.href, language: lang });
		const timeout = new Promise<null>(res => setTimeout(() => res(null), 12000));
		const result = await Promise.race([d.parseAsync(), timeout]) as { content?: string } | null;
		if (!result?.content) return [];
		const doc = new DOMParser().parseFromString(result.content, 'text/html');
		const out: DefuddlePara[] = [];
		for (const seg of Array.from(doc.querySelectorAll('.transcript-segment'))) {
			const tsEl = seg.querySelector('.timestamp');
			const start = tsEl ? parseFloat(tsEl.getAttribute('data-timestamp') || '') : NaN;
			if (isNaN(start)) continue;
			let text = seg.textContent || '';
			if (tsEl?.textContent) text = text.replace(tsEl.textContent, '');
			text = text.replace(/^\s*·\s*/, '').replace(/\s+/g, ' ').trim();
			if (text) out.push({ start, text });
		}
		return out;
	} catch (err) {
		console.warn('[obsidian-clipper] defuddle paragraphs failed:', err);
		return [];
	}
}

// --- Cue ↔ paragraph alignment -----------------------------------------------
// Defuddle's paragraph text is built from its own grouping of caption segments
// — same underlying source captions as our cues, just merged differently.
// We do a sequential token alignment: walk the paragraph's words and consume
// our cues' words in order. Each cue ends up with a [charStart, charEnd) range
// in the paragraph text. Non-matching tokens (Defuddle-only words from
// cleanup, e.g. an added period treated as part of the previous slice) are
// absorbed into the surrounding cue's range so the displayed text remains
// exactly Defuddle's.
interface TokenPos { lower: string; start: number; end: number; }
function tokenizeWithPositions(s: string): TokenPos[] {
	const out: TokenPos[] = [];
	const re = /\S+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s)) !== null) {
		out.push({ lower: m[0].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''), start: m.index, end: m.index + m[0].length });
	}
	return out;
}
function cueWords(text: string): string[] {
	return text.toLowerCase().split(/\W+/).map(w => w.replace(/[^\p{L}\p{N}]+/gu, '')).filter(Boolean);
}

// Align an ordered run of cues into one paragraph's text. Returns an array of
// { cue, charStart, charEnd } for cues that aligned successfully. Unmatched
// cues are dropped from the alignment (their span won't render, but the
// paragraph text is preserved verbatim).
interface Aligned { cue: TranscriptCue; charStart: number; charEnd: number; }
function alignCuesToParagraph(paraText: string, cues: TranscriptCue[]): Aligned[] {
	const tokens = tokenizeWithPositions(paraText);
	const out: Aligned[] = [];
	let ti = 0;
	for (const cue of cues) {
		const words = cueWords(cue.text);
		if (words.length === 0) continue;
		let firstHit = -1, lastHit = -1;
		let wi = 0;
		let scanFrom = ti;
		// Try to match each cue word in order, skipping unrelated paragraph
		// tokens (Defuddle may add tokens our cue doesn't have).
		while (wi < words.length && scanFrom < tokens.length) {
			if (tokens[scanFrom].lower === words[wi]) {
				if (firstHit === -1) firstHit = scanFrom;
				lastHit = scanFrom;
				wi++;
				scanFrom++;
			} else if (firstHit !== -1 && scanFrom - lastHit > 3) {
				// We started matching but drifted too far — give up on this cue.
				break;
			} else {
				scanFrom++;
			}
		}
		if (firstHit === -1 || wi < Math.max(1, words.length / 2)) {
			// Fewer than half the cue's words matched: alignment unreliable.
			continue;
		}
		out.push({ cue, charStart: tokens[firstHit].start, charEnd: tokens[lastHit].end });
		ti = lastHit + 1;
	}
	return out;
}

// Build paragraphs from Defuddle paragraph texts overlaid with our cues. Each
// emitted paragraph's cue list carries text slices of Defuddle's text (so
// concatenating spans reproduces Defuddle's paragraph exactly), with each
// slice carrying its real per-cue timestamp from our extractor.
function buildAlignedParagraphs(defuddlePs: DefuddlePara[], cues: TranscriptCue[]): TranscriptParagraph[] {
	if (defuddlePs.length === 0 || cues.length === 0) return [];
	const paras: TranscriptParagraph[] = [];
	let ci = 0;
	for (let p = 0; p < defuddlePs.length; p++) {
		const dp = defuddlePs[p];
		const nextStart = p + 1 < defuddlePs.length ? defuddlePs[p + 1].start : Infinity;
		// Pick cues that belong to this paragraph by time (small grace window
		// to account for Defuddle's start being the first-cue start of its group).
		const paraCues: TranscriptCue[] = [];
		while (ci < cues.length && cues[ci].start < nextStart) {
			if (cues[ci].start >= dp.start - 1) paraCues.push(cues[ci]);
			ci++;
		}
		if (paraCues.length === 0) continue;
		const aligned = alignCuesToParagraph(dp.text, paraCues);
		if (aligned.length === 0) continue;

		// Extend each cue's slice to cover all paragraph text up to the next
		// cue's start (so Defuddle's exact text is preserved — trailing
		// whitespace, added punctuation, etc.). The first cue's slice extends
		// from char 0 to cover any paragraph prefix.
		const sliceCues: TranscriptCue[] = [];
		for (let k = 0; k < aligned.length; k++) {
			const a = aligned[k];
			const sliceStart = k === 0 ? 0 : aligned[k - 1].charEnd;
			const sliceEnd = k === aligned.length - 1 ? dp.text.length : aligned[k + 1].charStart;
			const text = dp.text.slice(sliceStart, sliceEnd);
			if (!text) continue;
			sliceCues.push({ index: a.cue.index, start: a.cue.start, end: a.cue.end, text });
		}
		if (sliceCues.length) paras.push({ cues: sliceCues });
	}
	return paras;
}

// Fallback chunker for when Defuddle is unavailable (rare). Same Defuddle-
// style sentence grouping, but applied directly to our cues so we still emit
// readable paragraph blocks.

// YouTube cues are time-windowed, not sentence-windowed: a single cue can carry
// the tail of one sentence and the start of the next (e.g. "...compiler. And
// neither..."). Phase 1 of the chunker can only see cue boundaries, so we
// pre-split such cues at internal sentence ends. Both halves keep the original
// cue's start (timestamps within a split cue resolve to the same second — fine
// granularity loss for highlighting; the chunk boundary is what we care about).
function splitOnInternalSentences(cues: TranscriptCue[]): TranscriptCue[] {
	// sentence-end punct + optional closing quote/bracket + whitespace + an
	// uppercase letter / opening quote. CJK punctuation doesn't need the
	// capital-letter lookahead since the absence of inter-word spaces makes
	// `.X` itself diagnostic.
	const RE = /([.!?。！？]["')\]’”]?)\s+(?=[A-Z“"‘'])/g;
	const out: TranscriptCue[] = [];
	for (const c of cues) {
		RE.lastIndex = 0;
		const positions: number[] = [];
		let m: RegExpExecArray | null;
		while ((m = RE.exec(c.text)) !== null) positions.push(m.index + m[1].length);
		if (positions.length === 0) { out.push({ ...c, index: out.length }); continue; }
		let prev = 0;
		for (const pos of positions) {
			const piece = c.text.slice(prev, pos).trim();
			if (piece) out.push({ index: out.length, start: c.start, end: c.end, text: piece });
			prev = pos;
		}
		const tail = c.text.slice(prev).trim();
		if (tail) out.push({ index: out.length, start: c.start, end: c.end, text: tail });
	}
	return out;
}

// Group cues into paragraphs using Defuddle's `groupBySentence` algorithm,
// adapted to operate on our cue objects (preserving cue references rather
// than concatenating into a single text blob — we need per-cue spans for
// playback highlighting + selection→timestamp lookups).
//
// Rules (mirrors `node_modules/defuddle/dist/extractors/youtube.js:groupBySentence`):
//   - Flush the pending paragraph whenever a cue ends a sentence (.!?).
//   - Flush before a cue that's more than TRANSCRIPT_GROUP_GAP_SECONDS away
//     from the last one (a long speech pause = paragraph break).
//   - If a paragraph has been accumulating for ≥ TRANSCRIPT_MAX_GROUP_SECONDS
//     without ending a sentence (unpunctuated ASR), flush at the cue boundary.
//
// Mid-cue sentence boundaries (one cue containing "X. Y") are handled by
// `splitOnInternalSentences` upstream, so by the time cues reach here, every
// sentence ends at a cue boundary.
function semanticChunk(cues: TranscriptCue[]): TranscriptParagraph[] {
	if (cues.length === 0) return [];
	const paras: TranscriptParagraph[] = [];
	let pending: TranscriptCue[] = [];
	const flush = () => { if (pending.length) { paras.push({ cues: pending }); pending = []; } };

	for (const c of cues) {
		const prev = pending[pending.length - 1];
		if (prev && c.start - prev.start > TRANSCRIPT_GROUP_GAP_SECONDS) flush();
		pending.push(c);
		if (SENT_END.test(c.text)) { flush(); continue; }
		if (c.start - pending[0].start >= TRANSCRIPT_MAX_GROUP_SECONDS) flush();
	}
	flush();
	return paras;
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

	// Fetch in parallel: Defuddle gives us the paragraph *text* (its grouping +
	// cleanup); our extractor gives us fine-grained cues with real per-line
	// timestamps. We then overlay our cues onto Defuddle's paragraph texts via
	// token alignment, so the rendered text is exactly Defuddle's but each
	// embedded span has the precise timestamp from our cue stream.
	const [defuddlePs, raw] = await Promise.all([
		fetchDefuddleParagraphs(chosenLang),
		extractRawSegments({ language: chosenLang }),
	]);
	let cues: TranscriptCue[] | null = null;
	let paragraphs: TranscriptParagraph[] = [];
	if (raw && raw.length) {
		cues = raw.map((s, i) => ({ index: i, start: s.start, end: s.start, text: s.text }));
		for (let i = 0; i < cues.length; i++) {
			cues[i].end = i + 1 < cues.length ? cues[i + 1].start : cues[i].start + 5;
		}
		if (defuddlePs.length) {
			paragraphs = buildAlignedParagraphs(defuddlePs, cues);
			console.info('[obsidian-clipper] transcript:', cues.length, 'cues +', defuddlePs.length, 'defuddle paras →', paragraphs.length, 'aligned paragraphs');
		}
		// Fallback: if Defuddle gave us nothing or alignment yielded no paragraphs,
		// fall back to running our own grouping on the cues directly.
		if (paragraphs.length === 0) {
			paragraphs = semanticChunk(cues);
			console.info('[obsidian-clipper] transcript (fallback grouping):', cues.length, 'cues →', paragraphs.length, 'chunks');
		}
	}
	if (!cues || cues.length === 0) return null;

	transcriptCache.set(cacheKey, { cues, paragraphs });
	return { videoId, languageCode: chosenLang, tracks, cues, paragraphs };
}
