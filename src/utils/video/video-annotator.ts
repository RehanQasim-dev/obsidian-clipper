import {
	VideoColor, VideoItem, VideoMarkup, emptyMarkup, genVideoId,
	upsertVideoItem,
} from './video-storage';
import { renderMarkupSvg, snapLineTo45 } from './video-markup';
import { makeVideoNote, parseVideoNote, renderNoteHtml, formatVideoTime } from './video-notes';
import {
	getVideoElement, getVideoId, getVideoTitle, getPlayerContainer, isYouTubeWatchPage,
} from './youtube-detect';
import { captureFrame } from './frame-capture';

// In-page overlay for capturing + marking up a YouTube frame and attaching a
// chat-style comment thread. Lazy-loaded by content.ts on first use, so none of
// this (or its CSS-driving classes) touches non-YouTube pages.
//
// Flow (see plan): S → draw mode over the frozen frame; Enter saves, C advances
// to the comment panel, Esc discards. N → comment-only (frameless) panel.
// The overlay scopes itself to the <video>'s on-screen rect, mounted into the
// fullscreen element when fullscreen, so the same layout works in both modes.

type Mode = 'draw' | 'comment';
// 'select' is the neutral home state: no drawing happens, and Enter saves / Esc
// exits / N comments. Picking pencil/line/text activates that tool; Esc steps
// back to 'select' keeping whatever was drawn.
type Tool = 'select' | 'pencil' | 'line' | 'text';

let active = false;
let session = 0; // bumps each open; guards stale async/listeners

let video: HTMLVideoElement | null = null;
let wasPlaying = false;
let mode: Mode = 'draw';
let frameless = false;
let openedFullscreen = false; // was YouTube fullscreen when the overlay opened?

// Set while a text-label editor is open, so the global key handler can commit /
// cancel it (we route keys through onKeyDown to shield YouTube's shortcuts).
let activeTextCommit: (() => void) | null = null;
let activeTextCancel: (() => void) | null = null;

let watchUrl = '';
let videoId = '';
let videoTitle = '';
let videoTime = 0;
let item: VideoItem | null = null;

let currentTool: Tool = 'pencil';
let currentColor: VideoColor = 'yellow';
let markup: VideoMarkup = emptyMarkup();
const undoStack: VideoMarkup[] = [];

// DOM refs
let root: HTMLElement | null = null;
let frameWrap: HTMLElement | null = null;
let frameInner: HTMLElement | null = null; // image-aspect box; the drawing surface
let frameImg: HTMLImageElement | null = null;
let committedHolder: HTMLElement | null = null;
let liveSvg: SVGSVGElement | null = null;
let panel: HTMLElement | null = null;
let msgsEl: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;

export function isAnnotatorActive(): boolean {
	return active;
}

// --- Public entry points -----------------------------------------------------

export async function startCaptureAndDraw(): Promise<void> {
	if (active || !isYouTubeWatchPage()) return;
	video = getVideoElement();
	if (!video) return;
	prepareSession();
	const my = session;
	const frame = await captureFrame(video);
	if (session !== my || !active) return; // navigated/closed mid-capture
	if (!frame) { toast('Could not capture this frame'); teardown(false); return; }
	item = { id: genVideoId(), kind: 'frame', videoTime, frame, markup, notes: [] };
	frameless = false;
	mode = 'draw';
	buildOverlay();
}

export async function startCommentOnly(): Promise<void> {
	if (active || !isYouTubeWatchPage()) return;
	video = getVideoElement();
	if (!video) return;
	prepareSession();
	item = { id: genVideoId(), kind: 'note', videoTime, notes: [] };
	frameless = true;
	mode = 'comment';
	buildOverlay();
}

// --- Session lifecycle -------------------------------------------------------

function prepareSession() {
	active = true;
	session += 1;
	markup = emptyMarkup();
	undoStack.length = 0;
	selectedId = null;
	currentTool = 'pencil';
	currentColor = 'yellow';
	videoTime = video ? video.currentTime : 0;
	watchUrl = location.href;
	videoId = getVideoId();
	videoTitle = getVideoTitle();
	wasPlaying = !!video && !video.paused;
	openedFullscreen = !!document.fullscreenElement;
	if (video) video.pause();
}

// While in fullscreen, capture Escape so it closes our overlay instead of the
// browser force-exiting YouTube fullscreen. Released on teardown, after which a
// plain Esc exits fullscreen as usual. No-ops outside fullscreen / unsupported.
function lockEscape() {
	const kb = (navigator as unknown as { keyboard?: { lock?: (k: string[]) => Promise<void> } }).keyboard;
	if (openedFullscreen && kb?.lock) {
		try { kb.lock(['Escape'])?.catch(() => {}); } catch { /* ignore */ }
	}
}

function unlockEscape() {
	const kb = (navigator as unknown as { keyboard?: { unlock?: () => void } }).keyboard;
	if (kb?.unlock) {
		try { kb.unlock(); } catch { /* ignore */ }
	}
}

function mountTarget(): HTMLElement {
	return (document.fullscreenElement as HTMLElement | null) || getPlayerContainer() || document.body;
}

function positionRoot() {
	if (!root || !video) return;
	const el = video.getBoundingClientRect();
	// The <video> element box can be larger than the actual picture (letterbox
	// bars when the screen/player aspect differs from the video). Fit the video's
	// intrinsic aspect into the element box to get the true content rectangle, so
	// the overlay (and the drawing surface that fills it) covers exactly the
	// visible picture — no dead margins to "click into nothing".
	let { left, top, width: w, height: h } = el;
	const vw = video.videoWidth, vh = video.videoHeight;
	if (vw > 0 && vh > 0) {
		const va = vw / vh;
		const ea = el.width / el.height;
		if (ea > va) { h = el.height; w = h * va; } // bars left/right
		else { w = el.width; h = w / va; }          // bars top/bottom
		left = el.left + (el.width - w) / 2;
		top = el.top + (el.height - h) / 2;
	}
	root.style.left = `${left}px`;
	root.style.top = `${top}px`;
	root.style.width = `${w}px`;
	root.style.height = `${h}px`;
}

function buildOverlay() {
	root = document.createElement('div');
	root.className = `ob-vid-overlay mode-${mode}${frameless ? ' frameless' : ''}`;
	root.dataset.color = currentColor;
	root.dataset.tool = currentTool;

	// Frame side (image + markup + live draw layer + toolbar + hint)
	frameWrap = document.createElement('div');
	frameWrap.className = 'ob-vid-frame-wrap';

	// The inner box is sized to the captured frame's aspect ratio and centered, so
	// drawing coords (normalized to it) line up exactly with the saved image even
	// when the player letterboxes. Absent in frameless (comment-only) mode.
	if (!frameless && item?.frame) {
		frameInner = document.createElement('div');
		frameInner.className = 'ob-vid-frame-inner';
		frameInner.style.aspectRatio = `${item.frame.w} / ${item.frame.h}`;

		frameImg = document.createElement('img');
		frameImg.className = 'ob-vid-frame';
		frameImg.src = item.frame.dataUrl;
		frameInner.appendChild(frameImg);

		committedHolder = document.createElement('div');
		committedHolder.className = 'ob-vid-markup';
		frameInner.appendChild(committedHolder);

		frameWrap.appendChild(frameInner);
	}

	if (mode === 'draw') {
		buildDrawTools();
		const hint = document.createElement('div');
		hint.className = 'ob-vid-hint';
		hint.innerHTML = '<b>Enter</b> save · <b>N</b> comment · <b>Esc</b> select / exit';
		frameWrap.appendChild(hint);
		attachDrawHandlers();
	}

	// Chat panel
	panel = buildPanel();

	const stage = document.createElement('div');
	stage.className = 'ob-vid-stage';
	stage.appendChild(frameWrap);
	stage.appendChild(panel);
	root.appendChild(stage);

	mountTarget().appendChild(root);
	positionRoot();
	renderCommitted();

	window.addEventListener('resize', onReposition, true);
	window.addEventListener('scroll', onReposition, true);
	document.addEventListener('fullscreenchange', onFullscreenChange, true);
	// On `window` capture so we run before YouTube's own document-level key
	// handlers (which were registered at page load) — needed to stop Space from
	// reaching the player and toggling play while typing, in windowed mode too.
	window.addEventListener('keydown', onKeyDown, true);
	window.addEventListener('keyup', onKeyUpShield, true);
	window.addEventListener('keypress', onKeyUpShield, true);
	lockEscape();

	if (mode === 'comment') focusInput();
}

function onReposition() {
	positionRoot();
	renderCommitted();
}

function onFullscreenChange() {
	// Re-mount into the (new) fullscreen element / body so the overlay keeps
	// rendering, then reposition.
	if (!root) return;
	const target = mountTarget();
	if (root.parentElement !== target) target.appendChild(root);
	positionRoot();
	renderCommitted();
}

// --- Draw tools --------------------------------------------------------------

function buildDrawTools() {
	const bar = document.createElement('div');
	bar.className = 'ob-vid-toolbar';

	const tools: { tool: Tool; icon: string; label: string }[] = [
		{ tool: 'select', icon: '↖', label: 'Select (Esc) — Enter saves, N comments' },
		{ tool: 'pencil', icon: '✏️', label: 'Draw' },
		{ tool: 'line', icon: '╱', label: 'Line (Shift = snap)' },
		{ tool: 'text', icon: 'A', label: 'Text' },
	];
	for (const t of tools) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'ob-vid-tool' + (t.tool === currentTool ? ' is-active' : '');
		b.dataset.tool = t.tool;
		b.title = t.label;
		b.textContent = t.icon;
		b.addEventListener('click', () => setTool(t.tool));
		bar.appendChild(b);
	}

	const sep = document.createElement('span');
	sep.className = 'ob-vid-toolsep';
	bar.appendChild(sep);

	const colors: VideoColor[] = ['yellow', 'red', 'green'];
	for (const c of colors) {
		const sw = document.createElement('button');
		sw.type = 'button';
		sw.className = 'ob-vid-swatch ' + c + (c === currentColor ? ' is-active' : '');
		sw.dataset.color = c;
		sw.title = c;
		sw.addEventListener('click', () => setColor(c));
		bar.appendChild(sw);
	}

	frameWrap!.appendChild(bar);
}

function setTool(t: Tool) {
	currentTool = t;
	if (root) root.dataset.tool = t;
	root?.querySelectorAll('.ob-vid-tool').forEach(el =>
		el.classList.toggle('is-active', (el as HTMLElement).dataset.tool === t));
	// Leaving the select tool clears any selection highlight.
	if (t !== 'select' && selectedId) { selectedId = null; renderCommitted(); }
}

function setColor(c: VideoColor) {
	currentColor = c;
	if (root) root.dataset.color = c;
	root?.querySelectorAll('.ob-vid-swatch').forEach(el =>
		el.classList.toggle('is-active', (el as HTMLElement).dataset.color === c));
	// In select mode, a swatch also recolors the selected element.
	if (currentTool === 'select' && selectedId) recolorSelected(c);
}

// --- Drawing -----------------------------------------------------------------

let drawing = false;
let livePts: number[] = []; // pixel coords during a drag
let lineStart: { x: number; y: number } | null = null;

// Select-tool state: the currently selected markup element and an in-progress
// drag-to-move.
let selectedId: string | null = null;
let selDragging = false;
let selLast: { x: number; y: number } | null = null;
let selSnapshot: VideoMarkup | null = null; // pre-move state for undo

function wrapSize() {
	const surface = frameInner || frameWrap!;
	const r = surface.getBoundingClientRect();
	return { w: r.width, h: r.height, left: r.left, top: r.top };
}

function toLocal(e: PointerEvent) {
	const { left, top } = wrapSize();
	return { x: e.clientX - left, y: e.clientY - top };
}

function renderCommitted() {
	if (!committedHolder || !frameInner) return;
	const { w, h } = wrapSize();
	committedHolder.replaceChildren(renderMarkupSvg(markup, Math.max(1, w), Math.max(1, h), selectedId));
}

// --- Select-tool editing (move / recolor / delete / edit text) ---------------

// Distance from point (px,py) to segment (ax,ay)-(bx,by), in pixels.
function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax, dy = by - ay;
	const len2 = dx * dx + dy * dy;
	let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
	t = Math.max(0, Math.min(1, t));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// Geometric hit-test of a local (frameInner-relative) pixel point against the
// markup. Topmost-first (texts paint last, then lines, then strokes). Reliable
// regardless of SVG pointer-events.
function hitTest(lx: number, ly: number): string | null {
	const { w, h } = wrapSize();
	const TOL = 12;

	for (let i = markup.texts.length - 1; i >= 0; i--) {
		const t = markup.texts[i];
		// Prefer the rendered box's real bounds; fall back to an estimate.
		const div = committedHolder?.querySelector(`[data-mid="${t.id}"] > div`) as HTMLElement | null;
		if (div && frameInner) {
			const r = div.getBoundingClientRect();
			const fr = frameInner.getBoundingClientRect();
			const x = r.left - fr.left, y = r.top - fr.top;
			if (lx >= x - 4 && lx <= x + r.width + 4 && ly >= y - 4 && ly <= y + r.height + 4) return t.id;
		} else {
			const tx = t.x * w, ty = t.y * h, tw = (t.w || 0.28) * w;
			if (lx >= tx && lx <= tx + tw && ly >= ty && ly <= ty + h * 0.06) return t.id;
		}
	}
	for (let i = markup.lines.length - 1; i >= 0; i--) {
		const l = markup.lines[i];
		if (distToSeg(lx, ly, l.x1 * w, l.y1 * h, l.x2 * w, l.y2 * h) <= TOL) return l.id;
	}
	for (let i = markup.strokes.length - 1; i >= 0; i--) {
		const s = markup.strokes[i];
		const pts = s.points;
		if (pts.length === 2) {
			if (Math.hypot(lx - pts[0] * w, ly - pts[1] * h) <= TOL) return s.id;
			continue;
		}
		for (let j = 0; j < pts.length - 2; j += 2) {
			if (distToSeg(lx, ly, pts[j] * w, pts[j + 1] * h, pts[j + 2] * w, pts[j + 3] * h) <= TOL) return s.id;
		}
	}
	return null;
}

function selectedColor(): VideoColor | null {
	const s = markup.strokes.find(x => x.id === selectedId);
	if (s) return s.color;
	const l = markup.lines.find(x => x.id === selectedId);
	if (l) return l.color;
	const t = markup.texts.find(x => x.id === selectedId);
	return t ? t.color : null;
}

function translateSelected(dxNorm: number, dyNorm: number) {
	const clamp = (v: number) => Math.max(0, Math.min(1, v));
	const s = markup.strokes.find(x => x.id === selectedId);
	if (s) { for (let i = 0; i < s.points.length; i += 2) { s.points[i] = clamp(s.points[i] + dxNorm); s.points[i + 1] = clamp(s.points[i + 1] + dyNorm); } return; }
	const l = markup.lines.find(x => x.id === selectedId);
	if (l) { l.x1 = clamp(l.x1 + dxNorm); l.y1 = clamp(l.y1 + dyNorm); l.x2 = clamp(l.x2 + dxNorm); l.y2 = clamp(l.y2 + dyNorm); return; }
	const t = markup.texts.find(x => x.id === selectedId);
	if (t) { t.x = clamp(t.x + dxNorm); t.y = clamp(t.y + dyNorm); }
}

function deleteSelected() {
	if (!selectedId) return;
	pushUndoSnapshot();
	markup.strokes = markup.strokes.filter(x => x.id !== selectedId);
	markup.lines = markup.lines.filter(x => x.id !== selectedId);
	markup.texts = markup.texts.filter(x => x.id !== selectedId);
	selectedId = null;
	renderCommitted();
}

function recolorSelected(c: VideoColor) {
	if (!selectedId) return;
	const s = markup.strokes.find(x => x.id === selectedId);
	const l = markup.lines.find(x => x.id === selectedId);
	const t = markup.texts.find(x => x.id === selectedId);
	if (!s && !l && !t) return;
	pushUndoSnapshot();
	if (s) s.color = c;
	if (l) l.color = c;
	if (t) t.color = c;
	renderCommitted();
}

function ensureLiveSvg(): SVGSVGElement {
	const { w, h } = wrapSize();
	if (!liveSvg) {
		liveSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		liveSvg.setAttribute('class', 'ob-vid-live-svg');
		liveSvg.setAttribute('preserveAspectRatio', 'none');
		frameInner!.appendChild(liveSvg);
	}
	liveSvg.setAttribute('viewBox', `0 0 ${Math.max(1, w)} ${Math.max(1, h)}`);
	return liveSvg;
}

function clearLive() {
	if (liveSvg) { liveSvg.remove(); liveSvg = null; }
}

function pushUndoSnapshot() {
	undoStack.push(JSON.parse(JSON.stringify(markup)));
	if (undoStack.length > 50) undoStack.shift();
}

function colorHexAttr(): string {
	return currentColor;
}

function attachDrawHandlers() {
	const surface = frameInner;
	if (!surface) return;
	surface.addEventListener('pointerdown', onPointerDown);
	surface.addEventListener('pointermove', onPointerMove);
	surface.addEventListener('pointerup', onPointerUp);
	surface.addEventListener('pointerleave', onPointerUp);
	surface.addEventListener('dblclick', onDoubleClick);
}

function onPointerDown(e: PointerEvent) {
	if (e.button !== 0 || mode !== 'draw') return;

	// Select tool: click a markup element to select it (then drag to move); click
	// empty space to deselect. Hit-testing is geometric against the markup coords.
	if (currentTool === 'select') {
		const p = toLocal(e);
		const mid = hitTest(p.x, p.y);
		selectedId = mid;
		if (root) {
			root.querySelectorAll('.ob-vid-swatch').forEach(el =>
				el.classList.toggle('is-active', (el as HTMLElement).dataset.color === selectedColor()));
		}
		renderCommitted();
		if (mid) {
			selDragging = true;
			selLast = p;
			selSnapshot = JSON.parse(JSON.stringify(markup));
			frameInner?.setPointerCapture?.(e.pointerId);
			e.preventDefault();
		}
		return;
	}

	// Don't treat clicks on an in-progress text label as a new placement.
	if ((e.target as HTMLElement)?.classList?.contains('ob-vid-textinput')) return;
	const p = toLocal(e);

	if (currentTool === 'text') {
		// Prevent the default focus shift so our programmatic focus (deferred below)
		// actually sticks on the new input.
		e.preventDefault();
		placeTextInput(p.x, p.y);
		return;
	}

	drawing = true;
	(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
	const svg = ensureLiveSvg();
	svg.replaceChildren();
	if (currentTool === 'pencil') {
		livePts = [p.x, p.y];
		const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
		path.setAttribute('class', `ob-vid-livepath ${colorHexAttr()}`);
		svg.appendChild(path);
	} else {
		lineStart = { x: p.x, y: p.y };
		const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
		ln.setAttribute('class', `ob-vid-liveline ${colorHexAttr()}`);
		svg.appendChild(ln);
	}
	e.preventDefault();
}

function onPointerMove(e: PointerEvent) {
	// Drag-to-move the selected element (select tool).
	if (selDragging && selectedId && selLast) {
		const p = toLocal(e);
		const { w, h } = wrapSize();
		translateSelected((p.x - selLast.x) / Math.max(1, w), (p.y - selLast.y) / Math.max(1, h));
		selLast = p;
		renderCommitted();
		e.preventDefault();
		return;
	}

	if (!drawing || !liveSvg) return;
	const p = toLocal(e);
	if (currentTool === 'pencil') {
		const lx = livePts[livePts.length - 2];
		const ly = livePts[livePts.length - 1];
		if (Math.hypot(p.x - lx, p.y - ly) < 2) return;
		livePts.push(p.x, p.y);
		const path = liveSvg.firstChild as SVGPathElement;
		path.setAttribute('d', pixelPath(livePts));
	} else if (lineStart) {
		let end = { x: p.x, y: p.y };
		if (e.shiftKey) end = snapLineTo45(lineStart.x, lineStart.y, p.x, p.y);
		const ln = liveSvg.firstChild as SVGLineElement;
		ln.setAttribute('x1', String(lineStart.x));
		ln.setAttribute('y1', String(lineStart.y));
		ln.setAttribute('x2', String(end.x));
		ln.setAttribute('y2', String(end.y));
	}
	e.preventDefault();
}

function onPointerUp(e: PointerEvent) {
	// Finish a select-tool move: record the pre-move state for undo.
	if (selDragging) {
		selDragging = false;
		if (selSnapshot) { undoStack.push(selSnapshot); if (undoStack.length > 50) undoStack.shift(); }
		selSnapshot = null;
		selLast = null;
		return;
	}

	if (!drawing) return;
	drawing = false;
	const { w, h } = wrapSize();
	const nx = (v: number) => v / Math.max(1, w);
	const ny = (v: number) => v / Math.max(1, h);

	if (currentTool === 'pencil' && livePts.length >= 4) {
		pushUndoSnapshot();
		const pts: number[] = [];
		for (let i = 0; i < livePts.length; i += 2) { pts.push(nx(livePts[i]), ny(livePts[i + 1])); }
		markup.strokes.push({ id: genVideoId(), color: currentColor, points: pts });
		renderCommitted();
	} else if (currentTool === 'line' && lineStart) {
		const p = toLocal(e);
		let end = { x: p.x, y: p.y };
		if (e.shiftKey) end = snapLineTo45(lineStart.x, lineStart.y, p.x, p.y);
		if (Math.hypot(end.x - lineStart.x, end.y - lineStart.y) > 4) {
			pushUndoSnapshot();
			markup.lines.push({
				id: genVideoId(), color: currentColor,
				x1: nx(lineStart.x), y1: ny(lineStart.y), x2: nx(end.x), y2: ny(end.y),
			});
			renderCommitted();
		}
	}
	livePts = [];
	lineStart = null;
	clearLive();
}

function pixelPath(pts: number[]): string {
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

// `initial`/`boxOverride` are set when editing an existing label (double-click);
// in that case onDoubleClick already pushed the undo snapshot, so we don't push
// again here.
function placeTextInput(x: number, y: number, initial = '', boxOverride?: number) {
	const { w, h } = wrapSize();
	const editing = initial !== '';
	// A fixed-width box: text wraps to the next line within it (no endless single
	// line). Default font is a couple of points smaller than before.
	const boxPx = boxOverride ?? Math.min(Math.max(160, w * 0.28), w * 0.9);
	const fontPx = Math.max(11, h * 0.034);

	const ta = document.createElement('textarea');
	ta.className = `ob-vid-textinput ${currentColor}`;
	ta.rows = 1;
	ta.value = initial;
	ta.style.left = `${x}px`;
	ta.style.top = `${y}px`;
	ta.style.width = `${boxPx}px`;
	ta.style.fontSize = `${fontPx}px`;
	frameInner!.appendChild(ta);

	const autosize = () => { ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; };
	ta.addEventListener('input', autosize);
	autosize();
	// Defer focus so the browser's default pointerdown focus handling doesn't
	// immediately steal it back. Enter/Escape are handled in onKeyDown (Enter =
	// newline here; commit happens on blur / clicking away).
	setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 0);

	let done = false; // guard against a remove→blur double-commit
	const clearActive = () => {
		if (activeTextCommit === commit) { activeTextCommit = null; activeTextCancel = null; }
	};
	const commit = () => {
		if (done) return;
		done = true;
		const text = ta.value.trim();
		if (text) {
			if (!editing) pushUndoSnapshot();
			markup.texts.push({
				id: genVideoId(), color: currentColor,
				x: x / Math.max(1, w), y: y / Math.max(1, h),
				w: boxPx / Math.max(1, w), text,
			});
			renderCommitted();
		}
		ta.remove();
		clearActive();
	};
	const cancel = () => { done = true; ta.remove(); clearActive(); };
	activeTextCommit = commit;
	activeTextCancel = cancel;
	ta.addEventListener('blur', commit);
}

function undoMarkup() {
	const prev = undoStack.pop();
	if (!prev) return;
	markup = prev;
	if (item) item.markup = markup;
	selectedId = null;
	renderCommitted();
}

// Double-click a text label (select tool) to edit it: reopen the editor with its
// text, replacing the old label on commit.
function onDoubleClick(e: MouseEvent) {
	if (mode !== 'draw' || currentTool !== 'select' || !frameInner) return;
	const fr = frameInner.getBoundingClientRect();
	const mid = hitTest(e.clientX - fr.left, e.clientY - fr.top);
	if (!mid) return;
	const idx = markup.texts.findIndex(t => t.id === mid);
	if (idx < 0) return;
	const t = markup.texts[idx];
	const { w, h } = wrapSize();
	pushUndoSnapshot();
	const existing = t.text;
	const px = t.x * w, py = t.y * h, boxPx = (t.w || 0.28) * w;
	// Remove the old label; placeTextInput will add the edited one.
	markup.texts.splice(idx, 1);
	selectedId = null;
	renderCommitted();
	placeTextInput(px, py, existing, boxPx);
	e.preventDefault();
}

// --- Comment panel -----------------------------------------------------------

function buildPanel(): HTMLElement {
	const p = document.createElement('div');
	p.className = 'ob-vid-panel';

	const head = document.createElement('div');
	head.className = 'ob-vid-panel-head';
	const ts = document.createElement('span');
	ts.className = 'ob-vid-panel-time';
	ts.textContent = formatVideoTime(videoTime);
	const close = document.createElement('button');
	close.type = 'button';
	close.className = 'ob-vid-panel-close';
	close.title = 'Close (Esc)';
	close.textContent = '✕';
	close.addEventListener('click', () => teardown(true));
	head.appendChild(ts);
	head.appendChild(close);

	msgsEl = document.createElement('div');
	msgsEl.className = 'ob-vid-msgs';

	const inputWrap = document.createElement('div');
	inputWrap.className = 'ob-vid-input-wrap';
	inputEl = document.createElement('textarea');
	inputEl.className = 'ob-vid-input';
	inputEl.rows = 1;
	inputEl.placeholder = 'reply here';
	inputEl.addEventListener('input', autosizeInput);
	inputWrap.appendChild(inputEl);

	p.appendChild(head);
	p.appendChild(msgsEl);
	p.appendChild(inputWrap);
	return p;
}

function autosizeInput() {
	if (!inputEl) return;
	inputEl.style.height = 'auto';
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}

async function postMessage() {
	if (!inputEl || !item) return;
	const text = inputEl.value.trim();
	if (!text) return;
	item.notes.push(makeVideoNote(text, Date.now()));
	inputEl.value = '';
	autosizeInput();
	renderMessages();
	await persist();
}

function renderMessages() {
	if (!msgsEl || !item) return;
	msgsEl.replaceChildren();
	for (const note of item.notes) {
		const parsed = parseVideoNote(note);
		const bubble = document.createElement('div');
		bubble.className = 'ob-vid-msg';
		const body = document.createElement('div');
		body.className = 'ob-vid-msg-body';
		body.innerHTML = renderNoteHtml(parsed.text);
		bubble.appendChild(body);
		// Collapse long messages after ~3 lines with a show-more toggle.
		requestAnimationFrame(() => {
			if (body.scrollHeight - body.clientHeight > 4) {
				bubble.classList.add('is-collapsible');
				const more = document.createElement('button');
				more.type = 'button';
				more.className = 'ob-vid-msg-more';
				more.textContent = 'Show more';
				more.addEventListener('click', () => {
					const open = bubble.classList.toggle('is-open');
					more.textContent = open ? 'Show less' : 'Show more';
				});
				bubble.appendChild(more);
			}
		});
		msgsEl!.appendChild(bubble);
	}
	msgsEl.scrollTop = msgsEl.scrollHeight; // newest at bottom
}

function focusInput() {
	setTimeout(() => inputEl?.focus({ preventScroll: true }), 50);
}

// --- Persistence -------------------------------------------------------------

async function persist() {
	if (!item) return;
	item.markup = markup.strokes.length || markup.lines.length || markup.texts.length ? markup : undefined;
	await upsertVideoItem(watchUrl, videoId, videoTitle, item);
}

// --- Mode transitions --------------------------------------------------------

function goToComment() {
	if (mode === 'comment' || !root) return;
	mode = 'comment';
	root.classList.remove('mode-draw');
	root.classList.add('mode-comment');
	// Drop draw-only affordances; the frame is now read-only.
	clearLive();
	selectedId = null;
	frameWrap?.querySelector('.ob-vid-toolbar')?.remove();
	frameWrap?.querySelector('.ob-vid-hint')?.remove();
	// Re-render markup once the frame finishes its shrink animation.
	setTimeout(() => { renderCommitted(); }, 950);
	renderMessages();
	focusInput();
}

// --- Keyboard ----------------------------------------------------------------

// Some sites (incl. YouTube) toggle play on keyup/keypress too — shield those
// while typing in our boxes so Space doesn't reach the player.
function onKeyUpShield(e: KeyboardEvent) {
	if (!active) return;
	const t = e.target as HTMLElement;
	if (t?.classList?.contains('ob-vid-textinput') || t?.classList?.contains('ob-vid-input')) {
		e.stopPropagation();
	}
}

function onKeyDown(e: KeyboardEvent) {
	if (!active) return;
	const t = e.target as HTMLElement;
	const inText = !!t?.classList?.contains('ob-vid-textinput');
	const inChat = !!t?.classList?.contains('ob-vid-input');

	// While typing in our text-label or chat box, shield YouTube's player
	// shortcuts (e.g. Space toggling play) by stopping the event here — this runs
	// at window capture, before YouTube's handlers. Other keys (letters, space,
	// Shift+Enter) fall through so they type normally.
	if (inText || inChat) {
		e.stopPropagation();
		if (inText) {
			// Esc finishes typing: keep the text and return to the select tool.
			if (e.key === 'Escape') { e.preventDefault(); activeTextCommit?.(); setTool('select'); }
			// Enter = newline (let it through).
		} else { // chat box
			if (e.key === 'Escape') { e.preventDefault(); teardown(true); }
			else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postMessage(); }
		}
		return;
	}

	e.stopPropagation();

	if (mode === 'draw') {
		// Delete the selected element (select tool).
		if (selectedId && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); deleteSelected(); return; }
		// Undo a stroke/line/text regardless of tool.
		if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undoMarkup(); return; }
		if (e.key === '1') { e.preventDefault(); setColor('yellow'); return; }
		if (e.key === '2') { e.preventDefault(); setColor('red'); return; }
		if (e.key === '3') { e.preventDefault(); setColor('green'); return; }

		if (e.key === 'Escape') {
			e.preventDefault();
			// A tool active → step back to select, keeping what was drawn. Already on
			// select → discard the capture and resume the video.
			if (currentTool !== 'select') setTool('select');
			else teardown(false);
		} else if (e.key === 'Enter') {
			// Save the frame (with markup) and resume.
			e.preventDefault();
			saveAndClose();
		} else if (e.key === 'n' || e.key === 'N' || e.key === 'c' || e.key === 'C') {
			// Open the comment panel for this frame.
			e.preventDefault();
			persist().then(goToComment);
		}
	} else {
		if (e.key === 'Escape') { e.preventDefault(); teardown(true); }
	}
}

async function saveAndClose() {
	await persist();
	teardown(true);
}

// --- Teardown ----------------------------------------------------------------

function toast(msg: string) {
	const el = document.createElement('div');
	el.className = 'ob-vid-toast';
	el.textContent = msg;
	mountTarget().appendChild(el);
	setTimeout(() => el.remove(), 2200);
}

// `save` = whether the item (frame + thread) should remain persisted. In draw
// mode, Esc discards (save=false) since nothing was written yet.
function teardown(save: boolean) {
	// Defer releasing the Escape lock: if this teardown was triggered BY pressing
	// Escape, unlocking immediately would let that same Escape press (the browser
	// evaluates fullscreen-exit on keyup, after our keydown handler) also exit
	// fullscreen. A short delay keeps the lock through the whole key press so only
	// the overlay closes; a later Escape (lock released) exits fullscreen.
	setTimeout(unlockEscape, 400);
	window.removeEventListener('resize', onReposition, true);
	window.removeEventListener('scroll', onReposition, true);
	document.removeEventListener('fullscreenchange', onFullscreenChange, true);
	window.removeEventListener('keydown', onKeyDown, true);
	window.removeEventListener('keyup', onKeyUpShield, true);
	window.removeEventListener('keypress', onKeyUpShield, true);
	activeTextCommit = null;
	activeTextCancel = null;
	selectedId = null;
	selDragging = false;

	if (root) {
		root.classList.add('is-closing');
		const el = root;
		setTimeout(() => el.remove(), 250);
	}
	root = frameWrap = frameInner = committedHolder = panel = msgsEl = null;
	frameImg = null; inputEl = null; liveSvg = null;

	const resume = wasPlaying;
	const vid = video;
	active = false;
	mode = 'draw';
	item = null;
	markup = emptyMarkup();
	undoStack.length = 0;

	if (!save) {
		// Nothing persisted in draw mode until Enter/C; just resume.
	}
	if (vid && resume) vid.play().catch(() => {});
}
