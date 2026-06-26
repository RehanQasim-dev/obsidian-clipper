import {
	handleTextSelection,
	highlightElement,
	AnyHighlightData,
	BLOCK_HIGHLIGHT_TAGS,
	highlights,
	isApplyingHighlights,
	sortHighlights,
	applyHighlights,
	saveHighlights,
	updateHighlights,
	updateHighlighterMenu,
	updateHighlightColor,
	repositionHighlights,
} from './highlighter';
import { clearCommentBoxes, startAddingComment, emphasizeCommentBox } from './comment-overlays';
import { throttle } from './throttle';
import { getElementByXPath, isDarkColor, setElementHTML } from './dom-utils';
import { getMessage } from './i18n';
import { debugLog } from './debug';
import { resolveAnchor, type AnnotationAnchor } from '../../shared/anchor';

let touchStartX: number = 0;
let touchStartY: number = 0;
let isTouchMoved: boolean = false;

const IGNORED_BOUNDARY_SELECTOR =
	'.obsidian-highlighter-menu, .obsidian-reader-settings, .transcript-segment > strong, .obsidian-highlight-action-menu, .obsidian-comment-box, .obsidian-selection-action';

// --- Custom Highlight API (for type: 'text' highlights) ---
//
// Text highlights render via CSS.highlights instead of absolutely-positioned
// overlay divs. No DOM mutation, no position math on scroll/resize — the
// browser lays out decorations against the live text. Element/complex
// highlights still use overlays (they cover non-text regions).
//
// Requires CSS Custom Highlight API: Chrome 105+, Safari 17.2+, Firefox 140+.
// If unavailable the renderer silently no-ops.

const USER_HIGHLIGHT_NAME = 'obsidian-highlight';
// Priority below transcript-playback (default 0) so audio playback highlights
// paint on top inside transcripts.
const USER_HIGHLIGHT_PRIORITY = -1;

interface CSSHighlightsRegistry {
	set(name: string, value: unknown): void;
	delete(name: string): void;
}
interface HighlightInstance {
	add(range: Range): void;
	clear(): void;
	priority: number;
}

const HIGHLIGHT_INSTANCES = new Map<string, HighlightInstance>();
// Map of highlight id → list of Ranges. One stored highlight may produce
// multiple ranges in edge cases (future-proofing); today it's always one.
export const textHighlightRanges = new Map<string, Range[]>();

function getHighlightRegistry(): CSSHighlightsRegistry | null {
	const registry = (CSS as unknown as { highlights?: CSSHighlightsRegistry }).highlights;
	return registry ?? null;
}

let highlightApiWarned = false;
function ensureUserHighlight(color: string = 'yellow'): HighlightInstance | null {
	const registry = getHighlightRegistry();
	const HighlightCtor = (window as unknown as { Highlight?: new () => HighlightInstance }).Highlight;
	if (!registry || !HighlightCtor) {
		if (!highlightApiWarned) {
			debugLog('Clipper', 'CSS Custom Highlight API not available — text highlights will not render. Requires Chrome 105+, Safari 17.2+, or Firefox 140+.');
			highlightApiWarned = true;
		}
		return null;
	}
	
	const name = `obsidian-highlight-${color}`;
	if (HIGHLIGHT_INSTANCES.has(name)) {
		return HIGHLIGHT_INSTANCES.get(name)!;
	}

	const userHighlight = new HighlightCtor();
	userHighlight.priority = USER_HIGHLIGHT_PRIORITY;
	registry.set(name, userHighlight);
	HIGHLIGHT_INSTANCES.set(name, userHighlight);
	return userHighlight;
}

// Locate the text node containing a given character offset within an element.
// Offsets are natural character positions in the element's concatenated text.
// Returns null only if the element has no text descendants; otherwise clamps
// to the last text node's end when the offset overruns.
function findTextNodeAtOffset(element: Element, offset: number): { node: Node, offset: number } | null {
	// Skip the root — TreeWalker.currentNode starts there and the loop would
	// otherwise treat the whole element as a single text node (see the
	// mirror-image comment on getTextOffset in highlighter.ts).
	const treeWalker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
	let currentOffset = 0;
	let lastTextNode: Node | null = null;
	let node: Node | null = treeWalker.nextNode();
	while (node) {
		const nodeLength = node.textContent?.length || 0;
		if (currentOffset + nodeLength >= offset) {
			return { node, offset: Math.max(0, offset - currentOffset) };
		}
		lastTextNode = node;
		currentOffset += nodeLength;
		node = treeWalker.nextNode();
	}
	if (lastTextNode) {
		return { node: lastTextNode, offset: lastTextNode.textContent?.length ?? 0 };
	}
	return null;
}

export function renderTextHighlight(highlight: {
	id: string;
	xpath: string;
	startOffset: number;
	endOffset: number;
	color?: string;
	anchor?: AnnotationAnchor;
}): void {
	const hl = ensureUserHighlight(highlight.color || 'yellow');
	if (!hl) return;
	try {
		const range = resolveTextHighlightRange(highlight);
		if (!range || range.collapsed) return;
		hl.add(range);
		const existing = textHighlightRanges.get(highlight.id);
		if (existing) existing.push(range);
		else textHighlightRanges.set(highlight.id, [range]);
	} catch (e) {
		console.warn('Failed to build Range for text highlight', highlight.id, e);
	}
}

// Resolve where a text highlight paints on the *live page*. Web-origin highlights
// use the fast native xpath+offset path (unchanged behavior). When that fails —
// the page shifted, or the highlight was made in Obsidian (its xpath is for the
// note's DOM, not this page) — fall back to the portable text-quote anchor, which
// finds the same words regardless of structure. This is what makes a highlight
// created in Obsidian actually appear on the real web page.
function resolveTextHighlightRange(highlight: {
	xpath: string;
	startOffset: number;
	endOffset: number;
	anchor?: AnnotationAnchor;
}): Range | null {
	const anchor = highlight.anchor;
	// Native path only for web-origin highlights (no anchor = legacy web highlight).
	const webNative = !anchor || anchor.structural?.surface === 'web';
	if (webNative) {
		const container = getElementByXPath(highlight.xpath);
		if (container) {
			const start = findTextNodeAtOffset(container, highlight.startOffset);
			const end = findTextNodeAtOffset(container, highlight.endOffset);
			if (start && end) {
				const range = document.createRange();
				range.setStart(start.node, start.offset);
				range.setEnd(end.node, end.offset);
				if (!range.collapsed) return range;
			}
		}
	}
	// Text-quote fallback: works across surfaces and rescues broken xpaths.
	if (anchor) {
		const rl = resolveAnchor(anchor, document.body, 'web');
		if (rl) {
			const range = document.createRange();
			range.setStart(rl.startContainer, rl.startOffset);
			range.setEnd(rl.endContainer, rl.endOffset);
			if (!range.collapsed) return range;
		}
	}
	return null;
}

export function clearTextHighlights(): void {
	HIGHLIGHT_INSTANCES.forEach(hl => hl.clear());
	textHighlightRanges.clear();
	setActiveHighlight(null);
}

// --- Active-highlight emphasis ---
//
// When the cursor is on a comment box, emphasize the highlight that note
// belongs to so the user can see the association. Unified for both types:
//   - text  → painted into a dedicated, higher-priority CSS highlight layer
//             (`obsidian-highlight-active`) so it repaints natively on scroll,
//             with no stray per-line boxes.
//   - image / element → a purple glow on the overlay div.
// The purple accent matches the comment box's hover ring, tying the two ends
// of the association together visually.
// One active-emphasis layer per color, so the emphasized highlight keeps its
// own color (no purple wash) and gains a bright, solid underline in that same
// color (styled in highlighter.scss). A single color-agnostic layer couldn't
// match the underline to the highlight's color.
const ACTIVE_HIGHLIGHT_COLORS = ['yellow', 'red', 'green'] as const;
const activeHighlightInstances = new Map<string, HighlightInstance>();
let activeOverlayId: string | null = null;

function ensureActiveHighlight(color: string): HighlightInstance | null {
	const safeColor = (ACTIVE_HIGHLIGHT_COLORS as readonly string[]).includes(color) ? color : 'yellow';
	const existing = activeHighlightInstances.get(safeColor);
	if (existing) return existing;
	const registry = getHighlightRegistry();
	const HighlightCtor = (window as unknown as { Highlight?: new () => HighlightInstance }).Highlight;
	if (!registry || !HighlightCtor) return null;
	const inst = new HighlightCtor();
	inst.priority = 10; // above the color highlights so the emphasis wins
	registry.set(`obsidian-highlight-active-${safeColor}`, inst);
	activeHighlightInstances.set(safeColor, inst);
	return inst;
}

export function setActiveHighlight(id: string | null): void {
	// Clear any previous emphasis (all colors + every active element overlay; a
	// group can light up several at once, so clear by class rather than one id).
	activeHighlightInstances.forEach(inst => inst.clear());
	document.querySelectorAll('.obsidian-highlight-overlay.is-active')
		.forEach(el => el.classList.remove('is-active'));
	activeOverlayId = null;
	if (!id) return;

	const highlight = highlights.find((h: AnyHighlightData) => h.id === id);
	if (!highlight) return;

	// Emphasize the whole annotation: a multi-block selection (e.g. bullet
	// points) is one logical highlight, so hovering one piece lights up all.
	const members = highlight.groupId
		? highlights.filter((h: AnyHighlightData) => h.groupId === highlight.groupId)
		: [highlight];

	for (const m of members) {
		if (m.type === 'text') {
			const inst = ensureActiveHighlight(m.color || 'yellow');
			const ranges = textHighlightRanges.get(m.id);
			if (inst && ranges) ranges.forEach(r => inst.add(r));
		} else {
			document.querySelectorAll(`.obsidian-highlight-overlay[data-highlight-id="${m.id}"]`)
				.forEach(el => el.classList.add('is-active'));
			activeOverlayId = m.id;
		}
	}
}

function findOverlayAtPoint(x: number, y: number): HTMLElement | null {
	const overlays = document.querySelectorAll<HTMLElement>('.obsidian-highlight-overlay');
	for (let i = 0; i < overlays.length; i++) {
		const el = overlays[i];
		const r = el.getBoundingClientRect();
		if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return el;
	}
	return null;
}

// TODO: O(N × rects) per call. For pages with 50+ highlights, consider
// spatial indexing (e.g., a grid or interval tree) to reduce hit-test cost.
function findTextHighlightAtPoint(x: number, y: number): string | null {
	// Expand rects vertically to cover inter-line gaps (line-height spacing
	// between adjacent line rects). Without this, clicking between lines
	// of the same highlight wouldn't register.
	// NOTE: 4px padding could merge hover zones of highlights <8px apart
	// vertically. Unlikely in practice (line-height is usually 20px+).
	const PAD = 4;
	for (const [id, ranges] of textHighlightRanges) {
		for (const range of ranges) {
			const rects = range.getClientRects();
			for (let i = 0; i < rects.length; i++) {
				const rect = rects[i];
				if (x >= rect.left && x <= rect.right && y >= rect.top - PAD && y <= rect.bottom + PAD) {
					return id;
				}
			}
		}
	}
	return null;
}

// --- Floating remove button ---
//
// Shown on click/tap on any highlight, or on Alt+hover (desktop shortcut).
// Positioned center-top above the highlight's bounding box.


let highlightActionMenu: HTMLDivElement | null = null;
let currentActionTargetId: string | null = null;
let actionMenuShownViaAlt = false;

// Dwell-gating for switching the action menu between highlights. Moving the
// cursor from a highlight up to its floating menu can briefly cross a
// neighboring highlight; without this gate that transient crossing instantly
// re-targets the menu, so a color click lands on the wrong highlight (or the
// menu jumps away and the click misses entirely). Require the pointer to rest
// on a different highlight for a moment before the menu follows.
let pendingSwitchTargetId: string | null = null;
let pendingSwitchTimer: number | null = null;
function clearPendingSwitch(): void {
	pendingSwitchTargetId = null;
	if (pendingSwitchTimer) {
		clearTimeout(pendingSwitchTimer);
		pendingSwitchTimer = null;
	}
}

function ensureHighlightActionMenu(): HTMLDivElement {
	if (highlightActionMenu) return highlightActionMenu;
	
	const menu = document.createElement('div');
	menu.className = 'obsidian-highlight-action-menu';
	menu.style.display = 'none';
	menu.style.position = 'absolute';
	menu.style.zIndex = '2147483647';
	menu.style.gap = '4px';
	
	const colorPicker = document.createElement('div');
	colorPicker.className = 'obsidian-highlight-color-picker';
	colorPicker.style.display = 'flex';
	colorPicker.style.gap = '4px';
	colorPicker.style.padding = '4px';
	colorPicker.style.borderRight = '1px solid rgba(0,0,0,0.1)';
	
	const colors: Array<'yellow' | 'red' | 'green'> = ['yellow', 'red', 'green'];
	colors.forEach(color => {
		const btn = document.createElement('button');
		btn.className = `obsidian-highlight-color-btn color-${color}`;
		btn.setAttribute('aria-label', `Color ${color}`);
		btn.addEventListener('click', (e) => {
			e.stopPropagation();
			e.preventDefault();
			if (currentActionTargetId) updateHighlightColor(currentActionTargetId, color);
		});
		colorPicker.appendChild(btn);
	});

	const commentBtn = document.createElement('button');
	commentBtn.type = 'button';
	commentBtn.className = 'obsidian-highlight-comment';
	commentBtn.setAttribute('aria-label', getMessage('addComment') || 'Add Comment');
	setElementHTML(commentBtn, `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`);
	commentBtn.addEventListener('mousedown', e => e.stopPropagation());
	commentBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		e.preventDefault();
		if (currentActionTargetId) {
			startAddingComment(currentActionTargetId);
			hideHighlightActionMenu();
		}
	});

	const deleteBtn = document.createElement('button');
	deleteBtn.type = 'button';
	deleteBtn.className = 'obsidian-highlight-delete';
	deleteBtn.setAttribute('aria-label', getMessage('remove') || 'Remove');
	setElementHTML(deleteBtn, `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`);
	deleteBtn.addEventListener('mousedown', e => e.stopPropagation());
	deleteBtn.addEventListener('click', (e) => {
		e.stopPropagation();
		e.preventDefault();
		if (currentActionTargetId) {
			void deleteHighlightById(currentActionTargetId);
		}
	});

	menu.appendChild(colorPicker);
	menu.appendChild(commentBtn);
	menu.appendChild(deleteBtn);
	
	// Menu hover keeps it alive
	menu.addEventListener('mouseenter', () => {
		if (actionMenuHideTimeout) {
			clearTimeout(actionMenuHideTimeout);
			actionMenuHideTimeout = null;
		}
	});
	menu.addEventListener('mouseleave', () => {
		actionMenuHideTimeout = window.setTimeout(hideHighlightActionMenu, 300);
	});

	document.body.appendChild(menu);
	highlightActionMenu = menu;
	return menu;
}

function showHighlightActionMenuForText(id: string): void {
	const ranges = textHighlightRanges.get(id);
	if (!ranges || ranges.length === 0) return;
	const rects = ranges[0].getClientRects();
	if (rects.length === 0) return;
	// Compute bounding box across all line rects for center-top positioning.
	let left = Infinity, right = -Infinity, top = Infinity;
	for (let i = 0; i < rects.length; i++) {
		if (rects[i].left < left) left = rects[i].left;
		if (rects[i].right > right) right = rects[i].right;
		if (rects[i].top < top) top = rects[i].top;
	}
	positionActionMenu(id, (left + right) / 2, top);
}

function showHighlightActionMenuForOverlay(overlay: HTMLElement): void {
	const id = overlay.dataset.highlightId;
	if (!id) return;
	const rect = overlay.getBoundingClientRect();
	positionActionMenu(id, (rect.left + rect.right) / 2, rect.top);
}

function positionActionMenu(id: string, centerX: number, top: number): void {
	const menu = ensureHighlightActionMenu();
	currentActionTargetId = id;
	menu.style.display = 'flex';
	const menuWidth = menu.offsetWidth || 80;
	const idealLeft = centerX - menuWidth / 2;
	const clampedLeft = Math.max(4, Math.min(idealLeft, window.innerWidth - menuWidth - 4));
	menu.style.left = `${clampedLeft + window.scrollX}px`;
	menu.style.top = `${top + window.scrollY - 32}px`;
}

export let actionMenuHideTimeout: number | null = null;
export function hideHighlightActionMenu(): void {
	if (highlightActionMenu) highlightActionMenu.style.display = 'none';
	currentActionTargetId = null;
	actionMenuShownViaAlt = false;
	clearPendingSwitch();
	if (actionMenuHideTimeout) {
		clearTimeout(actionMenuHideTimeout);
		actionMenuHideTimeout = null;
	}
}

async function deleteHighlightById(id: string): Promise<void> {
	const target = highlights.find((h: AnyHighlightData) => h.id === id);
	if (!target) return;
	// If the highlight is part of a group (multi-block selection), remove the
	// whole group so the user's single selection acts as one logical delete.
	const next = target.groupId
		? highlights.filter((h: AnyHighlightData) => h.groupId !== target.groupId)
		: highlights.filter((h: AnyHighlightData) => h.id !== id);
	if (next.length === highlights.length) return;
	updateHighlights(next);
	hideHighlightActionMenu();
	sortHighlights();
	applyHighlights();
	saveHighlights();
	updateHighlighterMenu();
}

// Nearest ancestor that's a block-whitelist element (figure, picture, img,
// table, pre), or null. Used for one-click block highlighting. FIGURE wraps
// PICTURE/IMG semantically, so it's preferred when both exist in the chain.
function findBlockToHighlight(target: Element | null): Element | null {
	if (!target || target.closest(IGNORED_BOUNDARY_SELECTOR)) return null;
	return target.closest('figure') as Element | null
		?? target.closest('table') as Element | null
		?? target.closest('pre') as Element | null
		?? target.closest('picture') as Element | null
		?? target.closest('img') as Element | null;
}

// Show/hide the remove button on click/tap rather than hover, so it works
// on mobile (no hover). Clicking highlighted text shows the button;
// clicking elsewhere (or a different highlight) hides/repositions it.
let lastHighlightCreatedAt = 0;
export function markHighlightJustCreated(): void {
	lastHighlightCreatedAt = Date.now();
}

// --- Hide overlays while an image viewer / lightbox is open ---
//
// Element-highlight borders are absolutely-positioned divs over the image. When
// the image is clicked (outside highlighter mode) and opens in a lightbox or
// fullscreen viewer, that border can't follow — it would float at the image's
// old document position, on top of the viewer. So once we detect the image got
// covered, hide the overlays (and comment boxes) until the viewer closes.
const HIDDEN_FOR_VIEWER_CLASS = 'obsidian-highlight-overlays-hidden';
let imageViewTimer: number | null = null;
function clearImageViewTimer(): void {
	if (imageViewTimer) {
		clearInterval(imageViewTimer);
		imageViewTimer = null;
	}
}

// True when a modal/lightbox is painted on top of the element's center point.
// Returns false when the element is offscreen or not laid out (we can't conclude
// either way, so don't act).
//
// The hit-test walks up from whatever is topmost at the center: if it crosses a
// position:fixed layer before reaching the highlighted element, a modal covers
// it. This deliberately catches viewers that are DOM *descendants* of the
// highlighted element — e.g. an image lightbox appended inside the same
// <figure> as a `fixed inset-0` backdrop — which a plain contains() check would
// miss. An in-flow descendant shown in place (a caption inside the figure) has
// no fixed ancestor, so it correctly reads as "not covered".
function isElementCovered(el: Element): boolean {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return false;
	const cx = r.left + r.width / 2;
	const cy = r.top + r.height / 2;
	if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
	const top = document.elementFromPoint(cx, cy);
	if (!top) return false;
	let node: Element | null = top;
	while (node && node !== el) {
		if (window.getComputedStyle(node).position === 'fixed') return true;
		node = node.parentElement;
	}
	// Reached the element itself, or an in-flow descendant of it → not covered.
	if (el === top || el.contains(top)) return false;
	// Topmost element is outside the highlight (a separate overlay) → covered,
	// unless it's an ancestor we're sitting inside.
	return !top.contains(el);
}

// A highlighted image is "being viewed" when it has either been covered by a
// backdrop (classic lightbox) OR moved/resized away from where its border was
// painted (zoom-to-center libraries like medium-zoom transform the original
// image, so it isn't covered — it travels to the middle of the screen). Compare
// the live rect against the resting rect captured at click time, in document
// coordinates so page scrolling doesn't read as movement.
function isImageBeingViewed(el: Element, rest: { cx: number; cy: number; w: number; h: number }): boolean {
	if (!el.isConnected) return false;
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return isElementCovered(el);
	const cx = r.left + r.width / 2 + window.scrollX;
	const cy = r.top + r.height / 2 + window.scrollY;
	const moved = Math.abs(cx - rest.cx) > 24 || Math.abs(cy - rest.cy) > 24
		|| Math.abs(r.width - rest.w) > Math.max(24, rest.w * 0.25)
		|| Math.abs(r.height - rest.h) > Math.max(24, rest.h * 0.25);
	return moved || isElementCovered(el);
}

function watchImageForViewer(imageEl: Element): void {
	clearImageViewTimer();
	// Resting geometry in document coords, sampled before any viewer animation
	// (this runs in the capture phase, ahead of the page's own click handler).
	const r0 = imageEl.getBoundingClientRect();
	const rest = {
		cx: r0.left + r0.width / 2 + window.scrollX,
		cy: r0.top + r0.height / 2 + window.scrollY,
		w: r0.width,
		h: r0.height,
	};
	const startedAt = Date.now();
	let opened = false;
	imageViewTimer = window.setInterval(() => {
		const viewing = isImageBeingViewed(imageEl, rest);
		if (!opened) {
			if (viewing) {
				// A viewer opened — hide the overlays until it closes.
				opened = true;
				document.body.classList.add(HIDDEN_FOR_VIEWER_CLASS);
				hideHighlightActionMenu();
			} else if (Date.now() - startedAt > 1000) {
				// No viewer appeared (plain image / nothing happened) — stop watching
				// so we don't leave a timer running or flash the overlays.
				clearImageViewTimer();
			}
		} else if (!viewing) {
			// Viewer closed and the image returned to rest — restore the overlays,
			// repositioning them in case the image moved while the viewer was open.
			document.body.classList.remove(HIDDEN_FOR_VIEWER_CLASS);
			updateHighlightOverlayPositions();
			clearImageViewTimer();
		}
	}, 80);
}

function handleHighlightClick(event: MouseEvent) {
	const target = event.target as Element | null;

	// Outside highlighter mode, clicking a highlighted image opens it (lightbox
	// or navigation). Watch for a viewer covering it and hide the overlays while
	// it's open. Done before the a[href] short-circuit below because images are
	// commonly wrapped in <a href>. The click itself is left to proceed normally.
	if (!document.body.classList.contains('obsidian-highlighter-active')) {
		const ov = findOverlayAtPoint(event.clientX, event.clientY);
		if (ov?.classList.contains('obsidian-highlight-overlay-image') && ov.dataset.highlightId) {
			const h = highlights.find((x: AnyHighlightData) => x.id === ov.dataset.highlightId);
			const el = h ? getElementByXPath(h.xpath) : null;
			if (el) watchImageForViewer(el);
		}
	}

	// Clicking the action menu, selection button, or a link — let native behavior run.
	if (target?.closest('.obsidian-highlight-action-menu, .obsidian-selection-action, a[href]')) return;

	// Don't show the remove button immediately after creating a highlight —
	// the click that ends a drag-selection shouldn't also surface "Remove".
	if (Date.now() - lastHighlightCreatedAt < 300) return;

	const { clientX, clientY } = event;

	const isCtrlPressed = event.ctrlKey || event.metaKey;

	// Text highlight: hit-test stored Ranges.
	const textId = findTextHighlightAtPoint(clientX, clientY);
	if (textId) {
		if (isCtrlPressed) startAddingComment(textId);
		return;
	}

	// Element highlight overlay.
	const overlay = findOverlayAtPoint(clientX, clientY);
	if (overlay) {
		if (isCtrlPressed && overlay.dataset.highlightId) {
			startAddingComment(overlay.dataset.highlightId);
		}
		return;
	}

	hideHighlightActionMenu();
}

// Handle mouse up — create highlight from selection, or from block click.
// Fires only while highlighter is active (attached via toggleHighlighterMenu).
export function handleMouseUp(event: MouseEvent | TouchEvent) {
	let target: Element;
	if (event instanceof MouseEvent) {
		target = event.target as Element;
	} else {
		if (isTouchMoved) {
			isTouchMoved = false;
			return;
		}
		const touch = event.changedTouches[0];
		target = document.elementFromPoint(touch.clientX, touch.clientY) as Element;
	}

	// Mouseups inside our own UI (comment box, action menu, selection action)
	// must never create a highlight. In particular, double-clicking a comment
	// to edit it selects a word — without this guard that selection gets
	// hijacked into a new highlight and the selection is cleared, breaking the
	// comment's dblclick-to-edit.
	if (target?.closest('.obsidian-comment-box, .obsidian-highlight-action-menu, .obsidian-selection-action')) {
		return;
	}

	const selection = window.getSelection();
	if (selection && !selection.isCollapsed) {
		// When the user drags past the left/right edge of the content area,
		// browsers extend the selection vertically (up for left, down for
		// right), often selecting the entire article. Detect this by checking
		// whether mouseup landed outside the text column — if so, discard.
		// NOTE: only works in reader mode (.obsidian-reader-content). On live
		// pages the content container isn't known, so this guard is a no-op.
		if (event instanceof MouseEvent) {
			const readerContent = document.querySelector('.obsidian-reader-content');
			if (readerContent) {
				const bounds = readerContent.getBoundingClientRect();
				if (event.clientX < bounds.left || event.clientX > bounds.right) {
					selection.removeAllRanges();
					return;
				}
			}
		}
		const highlightId = handleTextSelection(selection);
		const isCtrlPressed = event instanceof MouseEvent && (event.ctrlKey || event.metaKey);
		if (highlightId && isCtrlPressed) {
			startAddingComment(highlightId);
		}
		return;
	}

	// Action menu / selection action button — let their own handlers run.
	if (target.closest('.obsidian-highlight-action-menu, .obsidian-selection-action')) return;

	// Block-level one-click highlight (figure, img, table, pre, picture).
	const block = findBlockToHighlight(target);
	if (block) {
		const isCtrlPressed = event instanceof MouseEvent && (event.ctrlKey || event.metaKey);
		const highlightId = highlightElement(block);
		if (highlightId && isCtrlPressed) {
			startAddingComment(highlightId);
		}
	}
}

// Add touch start handler
export function handleTouchStart(event: TouchEvent) {
	const touch = event.touches[0];
	touchStartX = touch.clientX;
	touchStartY = touch.clientY;
	isTouchMoved = false;
}

export function handleTouchMove(event: TouchEvent) {
	const touch = event.touches[0];
	const moveThreshold = 10;
	if (Math.abs(touch.clientX - touchStartX) > moveThreshold ||
		Math.abs(touch.clientY - touchStartY) > moveThreshold) {
		isTouchMoved = true;
	}
}

// Render one highlight. Text highlights go through the CSS Custom Highlight
// API; element highlights (figure, img, table, pre, picture) get one overlay
// div positioned over the target element.
export function planHighlightOverlayRects(target: Element, highlight: AnyHighlightData) {
	if (highlight.type === 'text') {
		renderTextHighlight(highlight);
		return;
	}
	const rect = target.getBoundingClientRect();
	const overlay = document.createElement('div');
	overlay.className = `obsidian-highlight-overlay color-${highlight.color || 'yellow'}`;
	// Images shouldn't be tinted — a color wash ruins the picture. Mark image
	// overlays so the CSS shows only a colored border around them instead.
	const tag = target.tagName.toUpperCase();
	const isImage = tag === 'IMG' || tag === 'PICTURE'
		|| (tag === 'FIGURE' && !!target.querySelector('img, picture'));
	if (isImage) overlay.classList.add('obsidian-highlight-overlay-image');
	// Preserve the hover emphasis if this overlay is being rebuilt while active.
	if (activeOverlayId === highlight.id) overlay.classList.add('is-active');
	overlay.dataset.highlightId = highlight.id;
	overlay.style.position = 'absolute';
	overlay.style.left = `${rect.left + window.scrollX - 2}px`;
	overlay.style.top = `${rect.top + window.scrollY - 2}px`;
	overlay.style.width = `${rect.width + 4}px`;
	overlay.style.height = `${rect.height + 4}px`;
	if (highlight.notes && highlight.notes.length > 0) {
		overlay.setAttribute('data-notes', JSON.stringify(highlight.notes));
	}
	const atPoint = document.elementFromPoint(rect.left, rect.top);
	if (atPoint && isDarkColor(getEffectiveBackgroundColor(atPoint as HTMLElement))) {
		overlay.classList.add('obsidian-highlight-overlay-dark');
	}
	document.body.appendChild(overlay);
}

function getEffectiveBackgroundColor(element: HTMLElement): string {
	let current: HTMLElement | null = element;
	while (current) {
		const bg = window.getComputedStyle(current).backgroundColor;
		if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
		current = current.parentElement;
	}
	return 'rgb(255, 255, 255)';
}

let reapplyTimeout: ReturnType<typeof setTimeout> | null = null;

// Reposition element overlays after layout changes. Text highlights paint
// against the live text via CSS.highlights and reposition natively.
function updateHighlightOverlayPositions() {
	let needsReapply = false;
	highlights.forEach((highlight) => {
		if (highlight.type === 'text') {
			const ranges = textHighlightRanges.get(highlight.id);
			if (ranges && ranges.length > 0) {
				// If the text node is no longer in the document (e.g. SPA hydration replaced it),
				// the highlight is broken and must be rebuilt.
				if (!document.body.contains(ranges[0].startContainer)) {
					needsReapply = true;
				}
			}
			return;
		}
		const target = getElementByXPath(highlight.xpath);
		if (!target) return;
		document.querySelectorAll(`.obsidian-highlight-overlay[data-highlight-id="${highlight.id}"]`)
			.forEach(el => el.remove());
		planHighlightOverlayRects(target, highlight);
	});

	if (needsReapply) {
		if (reapplyTimeout) clearTimeout(reapplyTimeout);
		reapplyTimeout = setTimeout(() => {
			repositionHighlights();
		}, 500);
	}
}

const throttledUpdateHighlights = throttle(() => {
	if (!isApplyingHighlights) updateHighlightOverlayPositions();
}, 100);

window.addEventListener('resize', () => { throttledUpdateHighlights(); hideHighlightActionMenu(); });
window.addEventListener('scroll', throttledUpdateHighlights);

// Our own injected UI (overlays, comment boxes, menus). Mutations to these are
// self-inflicted (e.g. toggling the `is-active` glow on an overlay) and must
// not trigger a reposition — rebuilding the overlay would instantly drop the
// class we just added, making the emphasis flash for a single frame.
function isOwnHighlighterUi(el: Element): boolean {
	if (el.id.startsWith('obsidian-highlight')) return true;
	const c = el.classList;
	return c.contains('obsidian-highlight-overlay')
		|| c.contains('obsidian-comment-box')
		|| c.contains('obsidian-highlight-action-menu')
		|| c.contains('obsidian-selection-action')
		|| c.contains('obsidian-highlighter-menu');
}

// Mutation observer re-positions element overlays when the page reflows.
// Lazily connected — observing document.body on every page the extension
// runs on (before any highlights exist) is wasted work, especially on busy
// SPAs. syncHoverListener connects/disconnects based on need.
const observer = new MutationObserver((mutations) => {
	if (isApplyingHighlights) return;
	const shouldUpdate = mutations.some(m => {
		if (!(m.target instanceof Element) || isOwnHighlighterUi(m.target)) return false;
		return m.type === 'childList'
			|| (m.type === 'attributes' && (m.attributeName === 'style' || m.attributeName === 'class'));
	});
	if (shouldUpdate) throttledUpdateHighlights();
});

// cursor:pointer on highlight hover + Alt+hover to surface the Remove
// button. Gated by rAF to avoid redundant hit-tests within the same frame.
let hoverRafPending = false;
let lastCursor = '';
function handleHighlightHover(event: MouseEvent) {
	if (hoverRafPending) return;
	// Capture values synchronously — the event object is reused.
	const { clientX, clientY, altKey } = event;
	const target = event.target as Element | null;
	hoverRafPending = true;
	requestAnimationFrame(() => {
		hoverRafPending = false;
		const textId = findTextHighlightAtPoint(clientX, clientY);
		const overlay = !textId ? findOverlayAtPoint(clientX, clientY) : null;
		const onHighlight = !!textId || !!overlay;
		
		const onButton = !!target?.closest('.obsidian-highlight-action-menu');
		const onCommentBox = !!target?.closest('.obsidian-comment-box');
		const onSelectionAction = !!target?.closest('.obsidian-selection-action');
		
		const shouldSuppressCursor = onHighlight || onButton || onCommentBox || onSelectionAction;
		if (shouldSuppressCursor) {
			document.body.classList.add('obsidian-highlighter-hover-suppress');
		} else {
			document.body.classList.remove('obsidian-highlighter-hover-suppress');
		}

		// Emphasize the comment box tied to whatever highlight the cursor is on,
		// so it's easy to see which note goes with which highlight. Only the
		// highlighted text triggers this — hovering or typing in the box itself
		// should not show the outer ring.
		emphasizeCommentBox(textId || overlay?.dataset.highlightId || null);

		const cursor = onHighlight ? 'pointer' : '';
		if (cursor !== lastCursor) { document.body.style.cursor = cursor; lastCursor = cursor; }

		if (onHighlight) {
			if (actionMenuHideTimeout) {
				clearTimeout(actionMenuHideTimeout);
				actionMenuHideTimeout = null;
			}
			const hoveredId = textId || overlay?.dataset.highlightId || null;
			const menuShown = highlightActionMenu?.style.display === 'flex';
			if (hoveredId === currentActionTargetId) {
				// Already targeting this highlight — drop any pending switch.
				clearPendingSwitch();
			} else if (!menuShown) {
				// No menu visible yet: show it immediately for this highlight.
				clearPendingSwitch();
				if (textId) showHighlightActionMenuForText(textId);
				else if (overlay) showHighlightActionMenuForOverlay(overlay);
			} else if (hoveredId && hoveredId !== pendingSwitchTargetId) {
				// Menu is open for a different highlight: only follow after a brief
				// dwell, so crossings while travelling to the menu don't hijack the
				// target (the cause of color clicks landing on the wrong highlight).
				pendingSwitchTargetId = hoveredId;
				if (pendingSwitchTimer) clearTimeout(pendingSwitchTimer);
				pendingSwitchTimer = window.setTimeout(() => {
					pendingSwitchTimer = null;
					pendingSwitchTargetId = null;
					if (textHighlightRanges.has(hoveredId)) {
						showHighlightActionMenuForText(hoveredId);
					} else {
						const ov = document.querySelector<HTMLElement>(
							`.obsidian-highlight-overlay[data-highlight-id="${hoveredId}"]`
						);
						if (ov) showHighlightActionMenuForOverlay(ov);
					}
				}, 180);
			}
		} else {
			clearPendingSwitch();
			if (!onButton && !actionMenuHideTimeout && highlightActionMenu?.style.display === 'flex') {
				actionMenuHideTimeout = window.setTimeout(hideHighlightActionMenu, 300);
			}
		}
	});
}

// Click + mousemove + mutation observer attached lazily — only when
// highlights exist on this page OR highlighter is active.
let listenersAttached = false;
let observerAttached = false;
export function syncHoverListener(): void {
	const isActive = document.body.classList.contains('obsidian-highlighter-active');
	const needed = highlights.length > 0 || isActive;
	if (needed && !listenersAttached) {
		// Capture phase so the click fires before disableLinkClicks()'s
		// stopPropagation on <a> elements — otherwise clicking highlighted
		// text inside or near a link never reaches a bubbling handler.
		document.addEventListener('click', handleHighlightClick, true);
		document.addEventListener('mousemove', handleHighlightHover);
		listenersAttached = true;
	} else if (!needed && listenersAttached) {
		document.removeEventListener('click', handleHighlightClick, true);
		document.removeEventListener('mousemove', handleHighlightHover);
		document.body.style.cursor = '';
		listenersAttached = false;
		hideHighlightActionMenu();
	}
	if (needed && !observerAttached) {
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ['style', 'class'],
			characterData: false,
		});
		observerAttached = true;
	} else if (!needed && observerAttached) {
		observer.disconnect();
		observerAttached = false;
	}
}

// Remove all existing highlight overlays from the page
export function removeExistingHighlights() {
	document.querySelectorAll('.obsidian-highlight-overlay').forEach(el => el.remove());
	clearTextHighlights();
	hideHighlightActionMenu();
	// renderCommentBoxes() handles its own cleanup. Clearing them here destroys
	// the active textarea (and any typed text) if applyHighlights() is triggered.
}