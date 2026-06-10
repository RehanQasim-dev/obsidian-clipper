import browser from './browser-polyfill';
import { normalizeUrl } from './highlighter';

// Freehand pencil tool. Unlike highlights (which anchor to DOM nodes via XPath
// and reflow with the page), pencil strokes are raw pixel paths stored in
// document coordinates — they do NOT reposition on reflow, by design. Strokes
// are persisted per normalized URL in browser.storage.local under `drawings`,
// rendered into a single full-document SVG overlay, and are visual-only (never
// exported to Markdown).
//
// Selection/deletion:
//   - Pencil mode: hold Ctrl to switch from drawing to a rectangle-marquee
//     selection of strokes; release Ctrl to resume drawing. A plain click on a
//     stroke selects it. Delete/Backspace removes the selection.
//   - Normal cursor mode (no pencil, no highlighter): click a stroke to select
//     it, or hold Ctrl and drag a box to select several; Delete removes them.
//     Only pencil strokes are selectable here — never highlights.

export type PencilColor = 'yellow' | 'red' | 'green';

const COLOR_HEX: Record<PencilColor, string> = {
	yellow: '#f5b800',
	red: '#ff6384',
	green: '#3fae6b',
};

const ACCENT = '#895DF4';

interface PencilStroke {
	id: string;
	color: PencilColor;
	width: number;
	// Flattened document-coordinate points: [x0, y0, x1, y1, ...].
	points: number[];
	// Wall-clock ms of the last change to this stroke; stamped in saveDrawings()
	// by diffing against the persisted copy. Used by the Google Drive sync engine
	// for last-write-wins conflict resolution. Optional for pre-sync data.
	updatedAt?: number;
}

interface StoredDrawings {
	url: string;
	strokes: PencilStroke[];
}
type DrawingsStorage = Record<string, StoredDrawings>;

const SVG_NS = 'http://www.w3.org/2000/svg';
const STROKE_WIDTH = 3;
// Drop points closer than this (px) while drawing — keeps stored arrays small
// and the path smooth without losing fidelity.
const MIN_POINT_DISTANCE = 2;
// Pointer must travel this far with Ctrl down before we treat it as a marquee
// (rather than a click), so a plain Ctrl+click still passes through to the page.
const MARQUEE_DRAG_THRESHOLD = 4;
// Hit-test tolerance for clicking a stroke to select it.
const HIT_TOLERANCE = STROKE_WIDTH + 6;

let strokes: PencilStroke[] = [];
let pencilActive = false;
let currentColor: PencilColor = 'yellow';

let selectedIds = new Set<string>();
let selecting = false; // Ctrl held → selection sub-mode

let svg: SVGSVGElement | null = null;

// Drawing state.
let drawing = false;
let currentPoints: number[] = [];
let livePath: SVGPathElement | null = null;

// Marquee state. Selection math uses document (page) coords; the visible box is
// a fixed-position div driven by viewport (client) coords so dragging it never
// repaints the full-document SVG layer (which made it feel sluggish).
let marqueePending = false; // Ctrl+pointerdown seen, awaiting a drag
let marqueeActive = false; // drag exceeded threshold → real marquee
let marqueeX0 = 0; // page coords (for selection)
let marqueeY0 = 0;
let marqueeClientX0 = 0; // client coords (for the visible box)
let marqueeClientY0 = 0;
let marqueeLastClientX = 0;
let marqueeLastClientY = 0;
let marqueeRafPending = false;
let marqueeEl: HTMLDivElement | null = null;

let suppressClick = false; // swallow the click that follows a consumed interaction
let listenersAttached = false;

function genId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getPageUrl(): string {
	return window.location.href;
}

function isHighlighterActive(): boolean {
	return document.body.classList.contains('obsidian-highlighter-active');
}

// Selection/drawing is live when the pencil is on, or — for delete-only use —
// when the page has strokes and no other tool owns the pointer.
function isEligible(): boolean {
	return pencilActive || (strokes.length > 0 && !isHighlighterActive());
}

// --- Geometry ----------------------------------------------------------------

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Topmost stroke (last drawn) whose path passes within tolerance of the point.
function hitStrokeAt(px: number, py: number): string | null {
	for (let s = strokes.length - 1; s >= 0; s--) {
		const pts = strokes[s].points;
		if (pts.length === 2) {
			if (Math.hypot(px - pts[0], py - pts[1]) <= HIT_TOLERANCE) return strokes[s].id;
			continue;
		}
		for (let i = 0; i < pts.length - 2; i += 2) {
			if (distToSegment(px, py, pts[i], pts[i + 1], pts[i + 2], pts[i + 3]) <= HIT_TOLERANCE) {
				return strokes[s].id;
			}
		}
	}
	return null;
}

function strokesInRect(minX: number, minY: number, maxX: number, maxY: number): string[] {
	const ids: string[] = [];
	for (const s of strokes) {
		for (let i = 0; i < s.points.length; i += 2) {
			const x = s.points[i];
			const y = s.points[i + 1];
			if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
				ids.push(s.id);
				break;
			}
		}
	}
	return ids;
}

// --- Rendering ---------------------------------------------------------------

function docSize(): { w: number; h: number } {
	const d = document.documentElement;
	const b = document.body;
	return {
		w: Math.max(d.scrollWidth, b ? b.scrollWidth : 0, d.clientWidth),
		h: Math.max(d.scrollHeight, b ? b.scrollHeight : 0, d.clientHeight),
	};
}

// A pencil-shaped cursor (mirroring the highlighter's custom SVG cursor): black
// shaft with a purple border, and a nib tinted with the active color. `nibHex`
// must be %23-encoded for use inside a data URI. Hotspot sits on the nib tip.
function pencilCursor(nibHex: string): string {
	const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 24 24'>`
		+ `<path d='M18.16 2.16 21.84 5.84 10.2 17.48 6.52 13.8Z' fill='%23000000' stroke='%23895DF4' stroke-width='1.75' stroke-linejoin='round'/>`
		+ `<path d='M10.2 17.48 6.52 13.8 2 22Z' fill='${nibHex}' stroke='%23895DF4' stroke-width='1.75' stroke-linejoin='round'/>`
		+ `</svg>`;
	return `url("data:image/svg+xml;utf8,${svg}") 3 29, crosshair`;
}

// One injected stylesheet for cursor / selection affordances. Strokes themselves
// render via inline SVG attributes, so drawings are visible on reload without
// this. The pencil cursor is suppressed while selecting (Ctrl held) in favor of
// a crosshair; text selection is only blocked during an actual marquee drag so
// Ctrl+C / Ctrl+A keep working.
function ensurePencilStyle(): void {
	if (document.getElementById('obsidian-pencil-style')) return;
	const style = document.createElement('style');
	style.id = 'obsidian-pencil-style';
	style.textContent = `
		.obsidian-pencil-active:not(.obsidian-pencil-selecting), .obsidian-pencil-active:not(.obsidian-pencil-selecting) * { cursor: ${pencilCursor('%23f5b800')} !important; }
		.obsidian-pencil-active[data-obsidian-pencil-color="red"]:not(.obsidian-pencil-selecting), .obsidian-pencil-active[data-obsidian-pencil-color="red"]:not(.obsidian-pencil-selecting) * { cursor: ${pencilCursor('%23ff6384')} !important; }
		.obsidian-pencil-active[data-obsidian-pencil-color="green"]:not(.obsidian-pencil-selecting), .obsidian-pencil-active[data-obsidian-pencil-color="green"]:not(.obsidian-pencil-selecting) * { cursor: ${pencilCursor('%233fae6b')} !important; }
		.obsidian-pencil-selecting, .obsidian-pencil-selecting * { cursor: crosshair !important; }
		.obsidian-pencil-active, .obsidian-pencil-marqueeing { -webkit-user-select: none !important; user-select: none !important; }
		.obsidian-pencil-marqueeing * { -webkit-user-select: none !important; user-select: none !important; }
		.obsidian-pencil-stroke { pointer-events: none; }
		.obsidian-pencil-stroke.is-selected { stroke-dasharray: 9 5; opacity: 0.7; }
	`;
	(document.head || document.documentElement).appendChild(style);
}

// Reflect the active color onto the body so the cursor's nib recolors.
function syncCursorColor(): void {
	if (pencilActive) document.body.dataset.obsidianPencilColor = currentColor;
}

function ensureSvg(): SVGSVGElement {
	ensurePencilStyle();
	if (svg && svg.isConnected) return svg;
	svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('class', 'obsidian-pencil-layer');
	svg.style.position = 'absolute';
	svg.style.left = '0';
	svg.style.top = '0';
	svg.style.pointerEvents = 'none';
	svg.style.overflow = 'visible';
	// High enough that pencil annotations stay visible above page content/chrome
	// (they're a deliberate overlay the user draws on top of everything); below
	// the highlighter's own floating menus.
	svg.style.zIndex = '2147483640';
	resizeSvg();
	document.body.appendChild(svg);
	return svg;
}

function resizeSvg(): void {
	if (!svg) return;
	const { w, h } = docSize();
	svg.setAttribute('width', String(w));
	svg.setAttribute('height', String(h));
	svg.style.width = `${w}px`;
	svg.style.height = `${h}px`;
}

// Build a smoothed path: quadratic curves through midpoints of successive
// points (vertices become control points). Falls back to straight segments for
// very short strokes.
function pointsToD(pts: number[]): string {
	if (pts.length < 2) return '';
	let d = `M ${pts[0]} ${pts[1]}`;
	if (pts.length < 6) {
		for (let i = 2; i < pts.length; i += 2) d += ` L ${pts[i]} ${pts[i + 1]}`;
		return d;
	}
	for (let i = 2; i < pts.length - 2; i += 2) {
		const xc = (pts[i] + pts[i + 2]) / 2;
		const yc = (pts[i + 1] + pts[i + 3]) / 2;
		d += ` Q ${pts[i]} ${pts[i + 1]} ${xc} ${yc}`;
	}
	d += ` L ${pts[pts.length - 2]} ${pts[pts.length - 1]}`;
	return d;
}

function createPathEl(color: PencilColor): SVGPathElement {
	const p = document.createElementNS(SVG_NS, 'path');
	p.setAttribute('class', 'obsidian-pencil-stroke');
	p.setAttribute('fill', 'none');
	p.setAttribute('stroke', COLOR_HEX[color]);
	p.setAttribute('stroke-width', String(STROKE_WIDTH));
	p.setAttribute('stroke-linecap', 'round');
	p.setAttribute('stroke-linejoin', 'round');
	return p;
}

function renderStrokes(): void {
	if (strokes.length === 0 && !svg) return;
	const layer = ensureSvg();
	resizeSvg();
	layer.textContent = '';
	for (const s of strokes) {
		const p = createPathEl(s.color);
		p.setAttribute('d', pointsToD(s.points));
		p.dataset.strokeId = s.id;
		if (selectedIds.has(s.id)) p.classList.add('is-selected');
		layer.appendChild(p);
	}
}

function createMarqueeDiv(): HTMLDivElement {
	const d = document.createElement('div');
	d.className = 'obsidian-pencil-marquee';
	d.style.position = 'fixed';
	d.style.left = '0';
	d.style.top = '0';
	d.style.width = '0';
	d.style.height = '0';
	d.style.border = `1px dashed ${ACCENT}`;
	d.style.background = 'rgba(137, 93, 244, 0.12)';
	d.style.pointerEvents = 'none';
	d.style.zIndex = '2147483641';
	d.style.boxSizing = 'border-box';
	return d;
}

function updateMarqueeDiv(): void {
	if (!marqueeEl) return;
	marqueeEl.style.left = `${Math.min(marqueeClientX0, marqueeLastClientX)}px`;
	marqueeEl.style.top = `${Math.min(marqueeClientY0, marqueeLastClientY)}px`;
	marqueeEl.style.width = `${Math.abs(marqueeLastClientX - marqueeClientX0)}px`;
	marqueeEl.style.height = `${Math.abs(marqueeLastClientY - marqueeClientY0)}px`;
}

// --- Storage -----------------------------------------------------------------

export async function loadDrawings(): Promise<void> {
	const url = normalizeUrl(getPageUrl());
	const result = await browser.storage.local.get('drawings');
	const all = (result.drawings || {}) as DrawingsStorage;
	const data = all[url];
	strokes = data && Array.isArray(data.strokes) ? data.strokes : [];
	if (strokes.length > 0) renderStrokes();
	syncListeners();
}

// Compare two strokes ignoring the sync-only `updatedAt` stamp.
function strokeContentEqual(a: PencilStroke, b: PencilStroke): boolean {
	const strip = ({ updatedAt, ...rest }: PencilStroke) => rest;
	return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function saveDrawings(): void {
	const url = normalizeUrl(getPageUrl());
	browser.storage.local.get('drawings').then((result: { drawings?: DrawingsStorage }) => {
		const all = result.drawings || {};
		if (strokes.length > 0) {
			// Stamp updatedAt on new/changed strokes so the sync engine can resolve
			// cross-device conflicts by most-recent edit.
			const prevById = new Map((all[url]?.strokes || []).map(s => [s.id, s]));
			const now = Date.now();
			strokes = strokes.map(s => {
				const prev = prevById.get(s.id);
				return (!prev || !strokeContentEqual(prev, s)) ? { ...s, updatedAt: now } : s;
			});
			all[url] = { url, strokes };
		} else {
			delete all[url];
		}
		browser.storage.local.set({ drawings: all });
	});
}

// Cross-tab sync: pick up drawing changes made in another tab for this URL.
browser.storage.onChanged.addListener((changes, area) => {
	if (area !== 'local' || !changes.drawings) return;
	const url = normalizeUrl(getPageUrl());
	const all = (changes.drawings.newValue || {}) as DrawingsStorage;
	const next = all[url]?.strokes ?? [];
	if (JSON.stringify(next) === JSON.stringify(strokes)) return;
	strokes = next;
	selectedIds = new Set([...selectedIds].filter(id => strokes.some(s => s.id === id)));
	renderStrokes();
	syncListeners();
});

// --- Selection ---------------------------------------------------------------

function selectOnly(id: string): void {
	selectedIds = new Set([id]);
	renderStrokes();
}

function clearSelection(): void {
	if (selectedIds.size === 0) return;
	selectedIds.clear();
	renderStrokes();
}

function deleteSelected(): void {
	if (selectedIds.size === 0) return;
	strokes = strokes.filter(s => !selectedIds.has(s.id));
	selectedIds.clear();
	saveDrawings();
	renderStrokes();
	syncListeners();
}

// --- Selection sub-mode (Ctrl held) ------------------------------------------

function enterSelecting(): void {
	if (selecting) return;
	selecting = true;
	document.body.classList.add('obsidian-pencil-selecting');
}

function cancelMarquee(): void {
	marqueePending = false;
	marqueeActive = false;
	marqueeRafPending = false;
	document.body.classList.remove('obsidian-pencil-marqueeing');
	if (marqueeEl) {
		marqueeEl.remove();
		marqueeEl = null;
	}
}

function exitSelecting(): void {
	if (!selecting) return;
	selecting = false;
	document.body.classList.remove('obsidian-pencil-selecting');
	cancelMarquee();
}

// --- Drawing -----------------------------------------------------------------

function startDrawing(event: PointerEvent): void {
	drawing = true;
	currentPoints = [event.pageX, event.pageY];
	const layer = ensureSvg();
	livePath = createPathEl(currentColor);
	livePath.setAttribute('d', pointsToD(currentPoints));
	layer.appendChild(livePath);
	event.preventDefault();
}

function cancelDrawing(): void {
	drawing = false;
	currentPoints = [];
	if (livePath) {
		livePath.remove();
		livePath = null;
	}
}

// --- Pointer handlers (shared between pencil mode and normal mode) -----------

function onPointerDown(event: PointerEvent): void {
	if (event.button !== 0 || !isEligible()) return;

	if (selecting) {
		// Defer committing to a marquee until the pointer actually drags, so a
		// plain Ctrl+click that misses a stroke still reaches the page.
		marqueePending = true;
		marqueeX0 = event.pageX;
		marqueeY0 = event.pageY;
		marqueeClientX0 = event.clientX;
		marqueeClientY0 = event.clientY;
		return;
	}

	const hit = hitStrokeAt(event.pageX, event.pageY);
	if (pencilActive) {
		if (hit) {
			selectOnly(hit);
			event.preventDefault();
			return;
		}
		clearSelection();
		startDrawing(event);
	} else {
		// Normal cursor mode: click a stroke to select it; click elsewhere clears.
		if (hit) {
			selectOnly(hit);
			suppressClick = true;
			event.preventDefault();
		} else {
			clearSelection();
		}
	}
}

function onPointerMove(event: PointerEvent): void {
	if (marqueePending && !marqueeActive) {
		if (Math.hypot(event.pageX - marqueeX0, event.pageY - marqueeY0) >= MARQUEE_DRAG_THRESHOLD) {
			marqueeActive = true;
			document.body.classList.add('obsidian-pencil-marqueeing');
			marqueeEl = createMarqueeDiv();
			document.body.appendChild(marqueeEl);
		}
	}
	if (marqueeActive) {
		marqueeLastClientX = event.clientX;
		marqueeLastClientY = event.clientY;
		// Coalesce to one DOM write per frame so fast drags stay smooth.
		if (!marqueeRafPending) {
			marqueeRafPending = true;
			requestAnimationFrame(() => {
				marqueeRafPending = false;
				updateMarqueeDiv();
			});
		}
		event.preventDefault();
		return;
	}
	if (!drawing || !livePath) return;
	const x = event.pageX;
	const y = event.pageY;
	const lastX = currentPoints[currentPoints.length - 2];
	const lastY = currentPoints[currentPoints.length - 1];
	if (Math.hypot(x - lastX, y - lastY) < MIN_POINT_DISTANCE) return;
	currentPoints.push(x, y);
	livePath.setAttribute('d', pointsToD(currentPoints));
	event.preventDefault();
}

function onPointerUp(event: PointerEvent): void {
	if (marqueePending || marqueeActive) {
		if (marqueeActive) {
			const ids = strokesInRect(
				Math.min(marqueeX0, event.pageX), Math.min(marqueeY0, event.pageY),
				Math.max(marqueeX0, event.pageX), Math.max(marqueeY0, event.pageY),
			);
			selectedIds = new Set(ids);
			suppressClick = true;
			event.preventDefault();
			cancelMarquee();
			renderStrokes();
		} else {
			// Ctrl+click with no drag: select a stroke if hit, else let it pass.
			const hit = hitStrokeAt(event.pageX, event.pageY);
			if (hit) {
				selectOnly(hit);
				suppressClick = true;
				event.preventDefault();
			} else {
				clearSelection();
			}
			marqueePending = false;
		}
		return;
	}

	if (!drawing) return;
	drawing = false;
	event.preventDefault();
	if (currentPoints.length >= 4) {
		strokes.push({ id: genId(), color: currentColor, width: STROKE_WIDTH, points: currentPoints });
		saveDrawings();
	}
	livePath = null;
	currentPoints = [];
	renderStrokes();
	syncListeners();
}

function onKeyDown(event: KeyboardEvent): void {
	const t = event.target;
	if (t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.closest('.obsidian-comment-editor'))) {
		return;
	}
	if (!isEligible()) return;

	if (event.key === 'Control' || event.key === 'Meta' || event.key === 'OS') {
		enterSelecting();
		return;
	}

	if (event.key === 'Delete' || event.key === 'Backspace') {
		if (selectedIds.size > 0) {
			event.preventDefault();
			deleteSelected();
		}
		return;
	}

	if (!pencilActive) return;

	if (event.key === 'Escape') {
		event.preventDefault();
		togglePencilMode(false);
	} else if (event.key === '1' || event.key === '2' || event.key === '3') {
		const colors: PencilColor[] = ['yellow', 'red', 'green'];
		currentColor = colors[parseInt(event.key) - 1];
		syncCursorColor();
		// Retint any selected strokes too, so the number keys recolor existing
		// lines as well as setting the color for the next one.
		if (selectedIds.size > 0) {
			let changed = false;
			for (const s of strokes) {
				if (selectedIds.has(s.id)) {
					s.color = currentColor;
					changed = true;
				}
			}
			if (changed) {
				saveDrawings();
				renderStrokes();
			}
		}
	}
}

function onKeyUp(event: KeyboardEvent): void {
	if (event.key === 'Control' || event.key === 'Meta' || event.key === 'OS') {
		exitSelecting();
	}
}

function onBlur(): void {
	// Releasing focus (e.g. switching apps) can swallow the Ctrl keyup — bail out
	// of selection mode so we don't get stuck.
	exitSelecting();
}

// Swallow the click that follows a consumed interaction (selecting a stroke,
// finishing a marquee, or any click while drawing) so the page underneath
// doesn't navigate. Plain page clicks pass through untouched.
function onClick(event: MouseEvent): void {
	if (pencilActive) {
		event.preventDefault();
		event.stopPropagation();
		return;
	}
	if (suppressClick) {
		suppressClick = false;
		event.preventDefault();
		event.stopPropagation();
	}
}

function onResize(): void {
	resizeSvg();
}

// --- Listener wiring ---------------------------------------------------------

// Attach the shared pointer/keyboard handlers whenever drawing or stroke
// selection should be live, and tear them down otherwise. Mirrors the
// highlighter's lazy-listener approach so pages with no strokes stay untouched.
function syncListeners(): void {
	const want = isEligible();
	if (want && !listenersAttached) {
		// Ensure the selecting/cursor rules exist before the user holds Ctrl, even
		// on a page whose strokes haven't triggered a render yet.
		ensurePencilStyle();
		document.addEventListener('pointerdown', onPointerDown, true);
		window.addEventListener('pointermove', onPointerMove, true);
		window.addEventListener('pointerup', onPointerUp, true);
		document.addEventListener('keydown', onKeyDown, true);
		document.addEventListener('keyup', onKeyUp, true);
		document.addEventListener('click', onClick, true);
		window.addEventListener('blur', onBlur);
		window.addEventListener('resize', onResize);
		listenersAttached = true;
	} else if (!want && listenersAttached) {
		document.removeEventListener('pointerdown', onPointerDown, true);
		window.removeEventListener('pointermove', onPointerMove, true);
		window.removeEventListener('pointerup', onPointerUp, true);
		document.removeEventListener('keydown', onKeyDown, true);
		document.removeEventListener('keyup', onKeyUp, true);
		document.removeEventListener('click', onClick, true);
		window.removeEventListener('blur', onBlur);
		window.removeEventListener('resize', onResize);
		listenersAttached = false;
		exitSelecting();
	}
}

// --- Public API --------------------------------------------------------------

export function isPencilActive(): boolean {
	return pencilActive;
}

export function togglePencilMode(active: boolean): void {
	if (pencilActive === active) return;
	pencilActive = active;
	document.body.classList.toggle('obsidian-pencil-active', active);

	if (active) {
		ensureSvg();
		syncCursorColor();
		renderStrokes();
	} else {
		cancelDrawing();
		exitSelecting();
		clearSelection();
		delete document.body.dataset.obsidianPencilColor;
	}
	syncListeners();
}
