/**
 * Shared annotation anchoring.
 *
 * This module is the single contract for *where* a highlight/comment lives, used
 * by both the browser extension (live web pages) and the Obsidian plugin
 * (rendered Markdown source notes). It is intentionally dependency-free — no
 * `browser.*`, no `obsidian`, no extension imports — so the exact same code runs
 * in a content script, an Electron renderer, and a unit test.
 *
 * An annotation carries TWO anchors:
 *
 *  - a **text-quote** anchor (`quote` + `prefix`/`suffix` context + `occurrence`):
 *    universal and portable. The same words exist in the live page and in the
 *    clipped Markdown, so this anchor resolves on *either* surface. It is always
 *    present and is the cross-surface bridge as well as the safety net when a
 *    structural anchor breaks.
 *
 *  - a **structural** anchor (`xpath` + offsets, tagged with the `surface` whose
 *    DOM it was captured in): the fast, exact path. An XPath into the live HTML
 *    DOM is meaningless in the rendered-Markdown DOM and vice-versa, so it is
 *    only trusted when `structural.surface` matches the surface being rendered.
 *
 * Resolution order on any surface S (see {@link resolveAnchor}):
 *   1. if `structural.surface === S` and the XPath resolves → use it (exact, cheap)
 *   2. otherwise, or if that fails → text-quote search
 *   3. if neither resolves → `null` (caller lists it as "unplaced", never silently drops)
 */

export type AnchorSurface = 'web' | 'obsidian';

/** Portable, structure-independent anchor based on the quoted text + context. */
export interface TextQuoteAnchor {
	/** The exact selected text. */
	quote: string;
	/** Up to {@link CONTEXT_LEN} characters immediately before the quote. */
	prefix: string;
	/** Up to {@link CONTEXT_LEN} characters immediately after the quote. */
	suffix: string;
	/**
	 * 0-based index disambiguating identical quote+context matches within the
	 * document. Usually 0; only > 0 when the same quote with the same surrounding
	 * context legitimately repeats.
	 */
	occurrence: number;
}

/** Fast, exact anchor — only valid on the surface it was captured in. */
export interface StructuralAnchor {
	surface: AnchorSurface;
	/** XPath to the element whose text content the offsets index into. */
	xpath: string;
	/** Character offset of the selection start within that element's text. */
	startOffset: number;
	/** Character offset of the selection end within that element's text. */
	endOffset: number;
}

/** Locates an image/element annotation by its source across surfaces. */
export interface ImageAnchor {
	/** The image's source URL (absolute where possible). The cross-surface bridge. */
	src: string;
	/** Alt text, for display + a secondary match when sources differ. */
	alt?: string;
}

/** The complete anchor stored on every annotation. */
export interface AnnotationAnchor {
	/** Universal — always present. */
	quote: TextQuoteAnchor;
	/** Per-surface fast path — optional, may be enriched lazily per surface. */
	structural?: StructuralAnchor;
	/**
	 * For image/element annotations: locate by image source instead of text.
	 * When present the annotation is an *image* annotation — `quote` is empty and
	 * resolution goes through {@link resolveImageElement}, not the text path.
	 */
	image?: ImageAnchor;
}

/** Characters of surrounding context captured on each side of a quote. */
export const CONTEXT_LEN = 32;

// ---------------------------------------------------------------------------
// Pure string core (no DOM — unit-testable in node)
// ---------------------------------------------------------------------------

/**
 * Build a text-quote anchor for the slice [start, end) of `fullText`.
 * `occurrence` is computed against the *other* identical quote+context matches
 * so that re-resolution is deterministic even when text repeats.
 */
export function buildTextQuote(fullText: string, start: number, end: number): TextQuoteAnchor {
	const quote = fullText.slice(start, end);
	let prefix = fullText.slice(Math.max(0, start - CONTEXT_LEN), start);
	let suffix = fullText.slice(end, Math.min(fullText.length, end + CONTEXT_LEN));

	if (typeof Intl !== 'undefined' && (Intl as any).Segmenter) {
		try {
			// In browser, document might not exist if this runs in worker, so use navigator.language fallback.
			const lang = typeof document !== 'undefined' && document.documentElement?.lang ? document.documentElement.lang : 'en';
			const segmenter = new (Intl as any).Segmenter(lang, { granularity: 'sentence' });
			const segments = segmenter.segment(fullText);
			
			const startSegment = segments.containing(start);
			if (startSegment) {
				const sentenceStart = startSegment.index;
				const prefixLen = Math.max(CONTEXT_LEN, Math.min(200, start - sentenceStart));
				prefix = fullText.slice(Math.max(0, start - prefixLen), start);
			}

			const endSegment = segments.containing(end);
			if (endSegment) {
				const sentenceEnd = endSegment.index + endSegment.segment.length;
				const suffixLen = Math.max(CONTEXT_LEN, Math.min(200, sentenceEnd - end));
				suffix = fullText.slice(end, end + suffixLen);
			}
		} catch (e) {
			// Fallback to exactly CONTEXT_LEN if Intl fails
		}
	}

	const anchor: TextQuoteAnchor = { quote, prefix, suffix, occurrence: 0 };

	// Count how many equally-good (same context score) matches occur before this
	// position — that index is our occurrence, so findTextQuote lands back here.
	const matches = scoredMatches(fullText, anchor);
	const best = matches[0]?.score ?? 0;
	anchor.occurrence = matches.filter((m) => m.score === best && m.index < start).length;
	return anchor;
}

interface ScoredMatch {
	index: number;
	score: number;
}

/** All exact-quote positions in `fullText`, scored by how well context matches. */
function scoredMatches(fullText: string, anchor: TextQuoteAnchor): ScoredMatch[] {
	const { quote, prefix, suffix } = anchor;
	if (!quote) return [];
	const out: ScoredMatch[] = [];
	let from = 0;
	for (;;) {
		const index = fullText.indexOf(quote, from);
		if (index === -1) break;
		out.push({ index, score: contextScore(fullText, index, quote.length, prefix, suffix) });
		from = index + Math.max(1, quote.length);
	}
	// Highest context score first; stable by position for equal scores.
	out.sort((a, b) => b.score - a.score || a.index - b.index);
	return out;
}

/** Number of matching context characters on both sides (higher = better). */
function contextScore(fullText: string, index: number, quoteLen: number, prefix: string, suffix: string): number {
	const before = fullText.slice(Math.max(0, index - prefix.length), index);
	const after = fullText.slice(index + quoteLen, index + quoteLen + suffix.length);
	return commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
}

function commonPrefixLen(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

function commonSuffixLen(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
	return i;
}

/**
 * Find the start offset of the best match for `anchor` in `fullText`.
 * Returns `null` when the quote does not occur at all.
 */
export function findTextQuote(fullText: string, anchor: TextQuoteAnchor): number | null {
	const matches = scoredMatches(fullText, anchor);
	const first = matches[0];
	if (!first) return null;
	const best = first.score;
	const equallyGood = matches.filter((m) => m.score === best).sort((a, b) => a.index - b.index);
	const pick = equallyGood[Math.min(anchor.occurrence, equallyGood.length - 1)] ?? first;
	return pick.index;
}

/**
 * Find the `[start, end)` span of the best match for `anchor` in `fullText`.
 *
 * Tries an exact match first (cheap, deterministic — same result as
 * {@link findTextQuote}), then falls back to a **whitespace-insensitive** match.
 * That fallback is what lets a quote captured on one surface resolve on another:
 * Obsidian's rendered Markdown is single-spaced, while a live web page's text
 * nodes carry raw newlines, indentation, and non-breaking spaces. An exact
 * `indexOf` fails across that gap; the normalized match succeeds and reports the
 * real span (so the caller paints the correct length, not `start + quote.length`).
 *
 * Returns `null` when the quote can't be located by either path.
 */
export function findTextQuoteRange(fullText: string, anchor: TextQuoteAnchor): { start: number; end: number } | null {
	const exact = findTextQuote(fullText, anchor);
	if (exact != null) return { start: exact, end: exact + anchor.quote.length };
	return findWhitespaceInsensitive(fullText, anchor);
}

/** Collapse each whitespace run to a single space, recording the original index of every output char. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
	let norm = '';
	const map: number[] = [];
	let inWs = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i] as string;
		if (/\s/.test(ch)) {
			if (!inWs) {
				norm += ' ';
				map.push(i); // collapsed run → its first char's original index
				inWs = true;
			}
		} else {
			norm += ch;
			map.push(i);
			inWs = false;
		}
	}
	return { norm, map };
}

const collapseWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Whitespace-insensitive search; disambiguates by collapsed context + occurrence, like the exact path. */
function findWhitespaceInsensitive(fullText: string, anchor: TextQuoteAnchor): { start: number; end: number } | null {
	const quoteNorm = collapseWs(anchor.quote);
	if (!quoteNorm) return null;
	const { norm, map } = normalizeWithMap(fullText);
	const prefixNorm = collapseWs(anchor.prefix);
	const suffixNorm = collapseWs(anchor.suffix);

	const scored: ScoredMatch[] = [];
	let from = 0;
	for (;;) {
		const index = norm.indexOf(quoteNorm, from);
		if (index === -1) break;
		const before = norm.slice(Math.max(0, index - prefixNorm.length), index);
		const after = norm.slice(index + quoteNorm.length, index + quoteNorm.length + suffixNorm.length);
		scored.push({ index, score: commonSuffixLen(before, prefixNorm) + commonPrefixLen(after, suffixNorm) });
		from = index + Math.max(1, quoteNorm.length);
	}
	scored.sort((a, b) => b.score - a.score || a.index - b.index);
	const first = scored[0];
	if (!first) return null;
	const best = first.score;
	const equallyGood = scored.filter((m) => m.score === best).sort((a, b) => a.index - b.index);
	const pick = equallyGood[Math.min(anchor.occurrence, equallyGood.length - 1)] ?? first;

	// Map the normalized span back to original offsets: start of the first matched
	// char, and one past the last matched char (so interior whitespace differences
	// are absorbed but no trailing whitespace is included).
	const start = map[pick.index];
	const lastChar = map[pick.index + quoteNorm.length - 1];
	if (start === undefined || lastChar === undefined) return null;
	return { start, end: lastChar + 1 };
}

// ---------------------------------------------------------------------------
// DOM adapters (guarded — require a live/Electron/linkedom DOM)
// ---------------------------------------------------------------------------

/**
 * The four boundary properties shared by a native DOM `Range`. We operate on
 * this minimal shape so the module never needs `Range.setStart`/`setEnd` (which
 * some DOM implementations omit). Convert to a native Range at the edge with
 * {@link toDomRange} when you actually need to mutate the document.
 */
export interface RangeLike {
	startContainer: Node;
	startOffset: number;
	endContainer: Node;
	endOffset: number;
}

/** Materialise a {@link RangeLike} into a native DOM `Range`. */
export function toDomRange(range: RangeLike, doc: Document): Range {
	const r = doc.createRange();
	r.setStart(range.startContainer, range.startOffset);
	r.setEnd(range.endContainer, range.endOffset);
	return r;
}

/** Tags whose text never participates in annotation. */
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

interface TextMap {
	text: string;
	/** Each entry: a text node and the char offset at which its text begins. */
	segments: Array<{ node: Text; start: number }>;
}

/**
 * Concatenate the visible text of `root` and remember where each text node
 * begins, so character offsets can be mapped back to DOM positions.
 * Skips script/style and any element flagged as annotation UI (`data-annot-ui`).
 */
export function buildTextMap(root: Node): TextMap {
	const segments: TextMap['segments'] = [];
	let text = '';
	const walk = (node: Node): void => {
		if (node.nodeType === 3 /* TEXT_NODE */) {
			const t = node as Text;
			const value = t.data;
			if (value) {
				segments.push({ node: t, start: text.length });
				text += value;
			}
			return;
		}
		if (node.nodeType !== 1 /* ELEMENT_NODE */) return;
		const el = node as Element;
		if (SKIP_TAGS.has(el.tagName)) return;
		if (el.hasAttribute && el.hasAttribute('data-annot-ui')) return;
		if (el.tagName.toUpperCase() === 'BR') {
			text += ' '; // Hypothesis battle-tested trick: synthesize space for <br> so words don't mash
			return;
		}
		for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
	};
	walk(root);
	return { text, segments };
}

/** Locate the text node + in-node offset for a global char offset. */
function locate(map: TextMap, offset: number): { node: Text; offset: number } | null {
	const { segments } = map;
	if (!segments.length) return null;
	// Binary search for the last segment starting at or before `offset`.
	let lo = 0;
	let hi = segments.length - 1;
	let found = 0;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const m = segments[mid];
		if (m && m.start <= offset) {
			found = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	const seg = segments[found];
	if (!seg) return null;
	const local = offset - seg.start;
	const len = seg.node.data.length;
	return { node: seg.node, offset: Math.max(0, Math.min(local, len)) };
}

/** Build a {@link RangeLike} spanning global char offsets [start, end) within `root`. */
export function locateRange(root: Node, start: number, end: number): RangeLike | null {
	const map = buildTextMap(root);
	const a = locate(map, start);
	const b = locate(map, end);
	if (!a || !b) return null;
	return { startContainer: a.node, startOffset: a.offset, endContainer: b.node, endOffset: b.offset };
}

/** Global char offsets [start, end) of a range within `root`, or null. */
export function offsetsFromRange(root: Node, range: RangeLike): { start: number; end: number } | null {
	const map = buildTextMap(root);
	const startIdx = globalOffset(map, range.startContainer, range.startOffset);
	const endIdx = globalOffset(map, range.endContainer, range.endOffset);
	if (startIdx == null || endIdx == null) return null;
	return startIdx <= endIdx ? { start: startIdx, end: endIdx } : { start: endIdx, end: startIdx };
}

function globalOffset(map: TextMap, container: Node, offset: number): number | null {
	if (container.nodeType === 3) {
		const seg = map.segments.find((s) => s.node === container);
		return seg ? seg.start + offset : null;
	}
	// Element container: offset is a child index; resolve to the first text node at/after it.
	const child = container.childNodes[offset] ?? null;
	if (!child) {
		// End of element — use end of its last descendant text node.
		const segs = map.segments.filter((s) => container.contains(s.node));
		const last = segs[segs.length - 1];
		return last ? last.start + last.node.data.length : null;
	}
	const seg = map.segments.find((s) => s.node === child || child.contains(s.node));
	return seg ? seg.start : null;
}

// ---------------------------------------------------------------------------
// XPath (self-contained; element-level, paired with text offsets)
// ---------------------------------------------------------------------------

/** Build an XPath to `el` relative to `root` using tag + sibling index. */
export function xpathForElement(el: Element, root: Node): string {
	const parts: string[] = [];
	let node: Node | null = el;
	while (node && node !== root && node.nodeType === 1) {
		const cur = node as Element;
		let index = 1;
		let sib = cur.previousElementSibling;
		while (sib) {
			if (sib.tagName === cur.tagName) index++;
			sib = sib.previousElementSibling;
		}
		parts.unshift(`${cur.tagName.toLowerCase()}[${index}]`);
		node = cur.parentNode;
	}
	return parts.length ? './' + parts.join('/') : '.';
}

/** Resolve an XPath built by {@link xpathForElement} back to an element. */
export function elementFromXPath(xpath: string, root: Node): Element | null {
	if (xpath === '.' || xpath === './') return root.nodeType === 1 ? (root as Element) : null;
	const steps = xpath.replace(/^\.\//, '').split('/').filter(Boolean);
	let current: Element | null = root.nodeType === 1 ? (root as Element) : null;
	const startEl = root.nodeType === 1 ? (root as Element) : (root as Document).documentElement;
	current = startEl;
	for (const step of steps) {
		if (!current) return null;
		const m = /^([a-z0-9-]+)\[(\d+)\]$/i.exec(step);
		const tag = m?.[1];
		if (!tag) return null;
		const want = Number(m[2]);
		let seen = 0;
		let next: Element | null = null;
		let child: Element | null = current.firstElementChild;
		while (child) {
			if (child.tagName.toLowerCase() === tag.toLowerCase()) {
				seen++;
				if (seen === want) {
					next = child;
					break;
				}
			}
			child = child.nextElementSibling;
		}
		current = next;
	}
	return current;
}

// ---------------------------------------------------------------------------
// Create / resolve (the public surface used by extension + plugin)
// ---------------------------------------------------------------------------

/**
 * Build a complete {@link AnnotationAnchor} for `range` measured against `root`,
 * tagging the structural anchor with the given `surface`.
 */
export function createAnchor(range: RangeLike, root: Node, surface: AnchorSurface): AnnotationAnchor | null {
	const offsets = offsetsFromRange(root, range);
	if (!offsets || offsets.start === offsets.end) return null;
	const map = buildTextMap(root);
	const quote = buildTextQuote(map.text, offsets.start, offsets.end);

	const anchor: AnnotationAnchor = { quote };

	// Structural fast path: XPath of the common-ancestor element + offsets within it.
	const ancestor = commonAncestorElement(range);
	if (ancestor && ancestor.nodeType === 1 && root.nodeType === 1) {
		const local = offsetsFromRange(ancestor, range);
		if (local) {
			anchor.structural = {
				surface,
				xpath: xpathForElement(ancestor, root),
				startOffset: local.start,
				endOffset: local.end,
			};
		}
	}
	return anchor;
}

/**
 * Resolve `anchor` to a {@link RangeLike} within `root` on the given `surface`.
 * Tries the native structural anchor first, then the universal text-quote
 * anchor. Returns `null` if neither resolves (the annotation is "unplaced").
 *
 * When resolving many anchors against the same `root` in a loop, pass the root's
 * concatenated text as `rootText` (from `buildTextMap(root).text`) so the
 * text-quote search doesn't re-walk the whole DOM per anchor. This is safe to
 * cache across `wrapRange` mutations because splitting/wrapping text nodes never
 * changes the concatenated text — only the segment→node mapping, which
 * `locateRange` always recomputes fresh.
 */
export function resolveAnchor(
	anchor: AnnotationAnchor,
	root: Node,
	surface: AnchorSurface,
	rootText?: string,
): RangeLike | null {
	// 1. Structural fast path, only when captured on this surface.
	const s = anchor.structural;
	if (s && s.surface === surface) {
		const el = elementFromXPath(s.xpath, root);
		if (el) {
			const localText = buildTextMap(el).text.slice(s.startOffset, s.endOffset);
			if (localText === anchor.quote.quote) {
				const range = locateRange(el, s.startOffset, s.endOffset);
				if (range) return range;
			}
			// XPath resolved but text drifted — fall through to text-quote.
		}
	}
	// 2. Universal text-quote fallback (whitespace-insensitive — see findTextQuoteRange).
	const text = rootText ?? buildTextMap(root).text;
	const span = findTextQuoteRange(text, anchor.quote);
	if (!span) return null;
	return locateRange(root, span.start, span.end);
}

// ---------------------------------------------------------------------------
// Image anchoring (match an <img> by source — the cross-surface bridge for
// image/element annotations, analogous to the text-quote anchor for text)
// ---------------------------------------------------------------------------

/** Build an image annotation anchor (empty text-quote + image source). */
export function createImageAnchor(src: string, alt?: string): AnnotationAnchor {
	return {
		quote: { quote: '', prefix: '', suffix: '', occurrence: 0 },
		image: { src, ...(alt ? { alt } : {}) },
	};
}

/** Resolve `src` to an absolute URL against `baseUrl` when possible; otherwise return it as-is. */
function absolutizeSrc(src: string, baseUrl?: string): string {
	if (!src) return '';
	try {
		return baseUrl ? new URL(src, baseUrl).href : new URL(src).href;
	} catch {
		return src;
	}
}

/** Last path segment without query/hash — a forgiving fallback when full URLs differ (CDN/proxy). */
function srcFilename(src: string): string {
	const noQuery = src.split(/[?#]/)[0] ?? src;
	return (noQuery.split('/').pop() ?? '').toLowerCase();
}

/** True when two image sources refer to the same image (exact, host+path, then filename). */
export function imageSrcMatches(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	try {
		const ua = new URL(a);
		const ub = new URL(b);
		if (ua.href === ub.href) return true;
		if (ua.host === ub.host && ua.pathname === ub.pathname) return true;
	} catch {
		/* one side not a full URL — fall through to filename compare */
	}
	const fa = srcFilename(a);
	return fa.length > 0 && fa === srcFilename(b);
}

/**
 * Find the `<img>` within `root` whose source matches the anchor's image, on any
 * surface. `baseUrl` (the note/page URL) resolves relative sources so a relative
 * embed and an absolute live-page src still match. Returns null when no image matches.
 */
export function resolveImageElement(anchor: AnnotationAnchor, root: Node, baseUrl?: string): Element | null {
	const want = anchor.image?.src;
	if (!want) return null;
	const parent = root as unknown as { querySelectorAll?: (sel: string) => ArrayLike<Element> };
	if (typeof parent.querySelectorAll !== 'function') return null;
	const wantAbs = absolutizeSrc(want, baseUrl);
	const imgs = Array.from(parent.querySelectorAll('img'));
	for (const img of imgs) {
		const raw = img.getAttribute('src') || (img as unknown as { src?: string }).src || '';
		if (!raw) continue;
		if (imageSrcMatches(want, raw) || imageSrcMatches(wantAbs, absolutizeSrc(raw, baseUrl))) return img;
	}
	return null;
}

function commonAncestorElement(range: RangeLike): Element | null {
	const a = range.startContainer;
	const b = range.endContainer;
	// Walk up from `a` until an ancestor also contains `b`.
	let node: Node | null = a;
	while (node) {
		if (node.nodeType === 1 && (node === b || (node as Element).contains?.(b))) {
			return node as Element;
		}
		node = node.parentNode;
	}
	// Fallback: nearest element ancestor of the start.
	node = a;
	while (node && node.nodeType !== 1) node = node.parentNode;
	return (node as Element) ?? null;
}
