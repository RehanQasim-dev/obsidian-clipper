/**
 * Reading-view highlight painter.
 *
 * Resolves each annotation's anchor against the rendered preview DOM (surface
 * `'obsidian'`) and wraps the covered text in `<span class="oc-hl">` elements so
 * they can carry color, hover, and click behavior. Annotations whose quote no
 * longer exists in the note are returned as `unplaced` so the caller can surface
 * them rather than silently dropping them.
 */

import { resolveAnchor, resolveImageElement, toDomRange, buildTextMap } from '../../shared/anchor';
import type { Annotation } from './store';

export const HL_CLASS = 'oc-hl';
export const HL_IMG_CLASS = 'oc-img-hl';
export const HL_ACTIVE_CLASS = 'oc-hl-active';
const COLOR_CLASSES = ['oc-hl-yellow', 'oc-hl-red', 'oc-hl-green'];

export interface PaintHandlers {
	onHover: (id: string | null) => void;
	onActivate: (id: string) => void;
}

export interface PaintResult {
	placed: string[];
	unplaced: Annotation[];
}

/** Unwrap every highlight span under `root` and clear image outlines. */
export function clearHighlights(root: HTMLElement): void {
	const spans = Array.from(root.querySelectorAll(`span.${HL_CLASS}`));
	for (const span of spans) {
		const parent = span.parentNode;
		if (!parent) continue;
		while (span.firstChild) parent.insertBefore(span.firstChild, span);
		parent.removeChild(span);
		parent.normalize();
	}
	for (const img of Array.from(root.querySelectorAll(`.${HL_IMG_CLASS}`))) {
		img.classList.remove(HL_IMG_CLASS, HL_ACTIVE_CLASS, 'oc-hl-has-comment', ...COLOR_CLASSES);
		delete (img as HTMLElement).dataset.annId;
	}
}

/** Re-resolve and re-paint all annotations against `root`. `baseUrl` resolves relative image sources. */
export function repaintHighlights(
	root: HTMLElement,
	anns: Annotation[],
	handlers: PaintHandlers,
	baseUrl?: string,
): PaintResult {
	clearHighlights(root);
	const placed: string[] = [];
	const unplaced: Annotation[] = [];
	const doc = root.ownerDocument;
	// Walk the preview text once and reuse it for every anchor's text-quote search
	// (wrapping below never changes the concatenated text — see resolveAnchor).
	const rootText = buildTextMap(root).text;

	for (const ann of anns) {
		// One annotation must never break the whole paint — isolate each.
		try {
			// Image annotation: outline the matching <img> rather than wrapping text.
			if (ann.anchor.image) {
				const img = resolveImageElement(ann.anchor, root, baseUrl);
				if (img) {
					markImage(img as HTMLElement, ann);
					placed.push(ann.id);
				} else {
					unplaced.push(ann);
				}
				continue;
			}
			const rl = resolveAnchor(ann.anchor, root, 'obsidian', rootText);
			if (!rl) {
				unplaced.push(ann);
				continue;
			}
			const range = toDomRange(rl, doc);
			const spans = wrapRange(range);
			if (!spans.length) {
				unplaced.push(ann);
				continue;
			}
			for (const span of spans) decorate(span, ann, handlers);
			placed.push(ann.id);
		} catch {
			unplaced.push(ann);
		}
	}
	return { placed, unplaced };
}

/** Outline an embedded image as a highlight. Idempotent; click/hover handled by delegation in main.ts. */
function markImage(img: HTMLElement, ann: Annotation): void {
	img.classList.add(HL_IMG_CLASS, `oc-hl-${ann.color}`);
	if (ann.comments.length) img.classList.add('oc-hl-has-comment');
	img.dataset.annId = ann.id;
}

function decorate(span: HTMLElement, ann: Annotation, handlers: PaintHandlers): void {
	span.dataset.annId = ann.id;
	span.dataset.color = ann.color;
	span.classList.add(`oc-hl-${ann.color}`);
	if (ann.comments.length) span.classList.add('oc-hl-has-comment');
	span.addEventListener('mouseenter', () => handlers.onHover(ann.id));
	span.addEventListener('mouseleave', () => handlers.onHover(null));
	span.addEventListener('click', (e) => {
		e.preventDefault();
		e.stopPropagation();
		handlers.onActivate(ann.id);
	});
}

/** Toggle the active emphasis on every span/image belonging to `id` (null clears all). */
export function setActiveHighlight(root: HTMLElement, id: string | null): void {
	root.querySelectorAll(`.${HL_ACTIVE_CLASS}`).forEach((el) => el.classList.remove(HL_ACTIVE_CLASS));
	if (!id) return;
	root
		.querySelectorAll(`span.${HL_CLASS}[data-ann-id="${cssEscape(id)}"], .${HL_IMG_CLASS}[data-ann-id="${cssEscape(id)}"]`)
		.forEach((el) => el.classList.add(HL_ACTIVE_CLASS));
}

/** Scroll the first span/image of `id` into view within the reading pane. */
export function scrollToHighlight(root: HTMLElement, id: string): void {
	const el = root.querySelector(
		`span.${HL_CLASS}[data-ann-id="${cssEscape(id)}"], .${HL_IMG_CLASS}[data-ann-id="${cssEscape(id)}"]`,
	);
	if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// --- range wrapping ---------------------------------------------------------

/** Wrap each text-node portion intersected by `range` in its own highlight span. */
function wrapRange(range: Range): HTMLElement[] {
	const doc = range.startContainer.ownerDocument;
	if (!doc) return [];
	const spans: HTMLElement[] = [];

	const textNodes: Text[] = [];
	if (range.commonAncestorContainer.nodeType === Node.TEXT_NODE) {
		textNodes.push(range.commonAncestorContainer as Text);
	} else {
		const walker = doc.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				return range.intersectsNode(node) && (node.nodeValue?.length ?? 0) > 0
					? NodeFilter.FILTER_ACCEPT
					: NodeFilter.FILTER_REJECT;
			},
		});
		let n = walker.nextNode();
		while (n) {
			textNodes.push(n as Text);
			n = walker.nextNode();
		}
	}

	for (const node of textNodes) {
		const start = node === range.startContainer ? range.startOffset : 0;
		const end = node === range.endContainer ? range.endOffset : node.length;
		if (end <= start) continue;
		const span = wrapPortion(node, start, end);
		if (span) spans.push(span);
	}
	return spans;
}

function wrapPortion(node: Text, start: number, end: number): HTMLElement | null {
	const doc = node.ownerDocument;
	if (!doc) return null;
	let target = node;
	if (start > 0) target = target.splitText(start);
	if (end - start < target.length) target.splitText(end - start);
	const span = doc.createElement('span');
	span.className = HL_CLASS;
	target.parentNode?.insertBefore(span, target);
	span.appendChild(target);
	return span;
}

/** Minimal CSS attribute-value escape for our timestamp-based ids. */
function cssEscape(value: string): string {
	return value.replace(/["\\]/g, '\\$&');
}
