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

/** The complete anchor stored on every annotation. */
export interface AnnotationAnchor {
	/** Universal — always present. */
	quote: TextQuoteAnchor;
	/** Per-surface fast path — optional, may be enriched lazily per surface. */
	structural?: StructuralAnchor;
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
	const prefix = fullText.slice(Math.max(0, start - CONTEXT_LEN), start);
	const suffix = fullText.slice(end, Math.min(fullText.length, end + CONTEXT_LEN));
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
 */
export function resolveAnchor(anchor: AnnotationAnchor, root: Node, surface: AnchorSurface): RangeLike | null {
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
	// 2. Universal text-quote fallback.
	const map = buildTextMap(root);
	const start = findTextQuote(map.text, anchor.quote);
	if (start == null) return null;
	return locateRange(root, start, start + anchor.quote.quote.length);
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
