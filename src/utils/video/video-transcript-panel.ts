import {
	VideoItem, VideoColor, VideoFrameImage, genVideoId, upsertVideoItem, loadVideoData,
} from './video-storage';
import {
	getVideoElement, getVideoId, getVideoTitle, getPlayerContainer, isYouTubeWatchPage,
} from './youtube-detect';
import {
	LoadedTranscript, TranscriptCue, loadTranscript, getSessionLang, setSessionLang,
} from './video-transcript';
import { openComments, isCommentsActive } from './video-comments';
import { captureFrame } from './frame-capture';
import { buildFrameSide, buildDimBackdrop } from './video-stage';

// Live YouTube transcript-annotation panel (the `T` flow). Pauses the video and
// docks a scrollable transcript on the right, auto-scrolled to a fixed 30s
// behind the current moment. The user highlights the spoken line(s) with the
// familiar color-swatch popup; each highlight derives its M:SS–M:SS range from
// the covered caption cues and is stored as a kind:'transcript' VideoItem.
// "Comment" / double-click opens the per-video conversation panel for it. All of
// the video's saved transcript highlights are repainted inline while scrolling.

const LOOKBACK_SECONDS = 30;

let active = false;
let session = 0;

let video: HTMLVideoElement | null = null;
let wasPlaying = false;
let openedFullscreen = false;
let watchUrl = '';
let videoId = '';
let videoTitle = '';
let videoTime = 0;

let transcript: LoadedTranscript | null = null;
let saved: VideoItem[] = []; // existing kind:'transcript' items for this video
let capturedFrame: VideoFrameImage | null = null;

let root: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let popupEl: HTMLElement | null = null;

// Pending selection captured when the swatch popup is shown.
interface PendingSel {
	startCue: number; startOffset: number;
	endCue: number; endOffset: number;
	quote: string;
}
let pendingSel: PendingSel | null = null;

export function isTranscriptPanelActive(): boolean {
	return active;
}

export async function startTranscriptAnnotate(): Promise<void> {
	if (active || isCommentsActive() || !isYouTubeWatchPage()) return;
	video = getVideoElement();
	if (!video) return;
	videoId = getVideoId();
	if (!videoId) return;

	const my = ++session;
	active = true;
	watchUrl = location.href;
	videoTitle = getVideoTitle();
	videoTime = video.currentTime;
	wasPlaying = !video.paused;
	openedFullscreen = !!document.fullscreenElement;

	transcript = await loadTranscript(videoId, getSessionLang(videoId));
	if (my !== session) return; // cancelled mid-fetch
	if (!transcript) {
		active = false;
		toast('No transcript available for this video');
		return;
	}

	video.pause();
	capturedFrame = await captureFrame(video);
	if (my !== session) return;
	const data = await loadVideoData(watchUrl);
	if (my !== session) return;
	saved = data ? data.items.filter(i => i.kind === 'transcript' && i.anchor) : [];

	build();
}

// --- Layout ------------------------------------------------------------------

function mountTarget(): HTMLElement {
	return (document.fullscreenElement as HTMLElement | null) || getPlayerContainer() || document.body;
}

function positionRoot() {
	if (!root || !video) return;
	const el = video.getBoundingClientRect();
	let { left, top, width: w, height: h } = el;
	const vw = video.videoWidth, vh = video.videoHeight;
	if (vw > 0 && vh > 0) {
		const va = vw / vh;
		const ea = el.width / el.height;
		if (ea > va) { h = el.height; w = h * va; }
		else { w = el.width; h = w / va; }
		left = el.left + (el.width - w) / 2;
		top = el.top + (el.height - h) / 2;
	}
	root.style.left = `${left}px`;
	root.style.top = `${top}px`;
	root.style.width = `${w}px`;
	root.style.height = `${h}px`;
}

function build() {
	root = document.createElement('div');
	root.className = 'ob-vid-overlay mode-comment ob-vt-root';

	const stage = document.createElement('div');
	stage.className = 'ob-vid-stage';
	stage.appendChild(buildFrameSide(capturedFrame));

	const panel = document.createElement('div');
	panel.className = 'ob-vid-panel ob-vt-panel';

	const head = document.createElement('div');
	head.className = 'ob-vid-panel-head';
	const titleWrap = document.createElement('div');
	titleWrap.className = 'ob-vt-head-left';
	const title = document.createElement('span');
	title.className = 'ob-vid-panel-time';
	title.textContent = 'Transcript';
	titleWrap.appendChild(title);
	titleWrap.appendChild(buildLangPicker());
	const close = document.createElement('button');
	close.type = 'button';
	close.className = 'ob-vid-panel-close';
	close.title = 'Save & close (Esc)';
	close.textContent = '✕';
	close.addEventListener('click', () => teardown());
	head.appendChild(titleWrap);
	head.appendChild(close);

	listEl = document.createElement('div');
	listEl.className = 'ob-vt-list';
	listEl.addEventListener('mouseup', onSelectionEnd);
	listEl.addEventListener('dblclick', onListDblClick);
	listEl.addEventListener('scroll', () => removePopup());

	panel.appendChild(head);
	panel.appendChild(listEl);
	stage.appendChild(panel);
	root.appendChild(buildDimBackdrop());
	root.appendChild(stage);
	mountTarget().appendChild(root);
	positionRoot();

	renderTranscript();
	scrollToLookback();

	window.addEventListener('resize', positionRoot, true);
	window.addEventListener('scroll', positionRoot, true);
	document.addEventListener('fullscreenchange', onFullscreenChange, true);
	window.addEventListener('keydown', onKeyDown, true);
	window.addEventListener('keyup', onKeyUpShield, true);
	window.addEventListener('keypress', onKeyUpShield, true);
	lockEscape();
}

function buildLangPicker(): HTMLElement {
	const sel = document.createElement('select');
	sel.className = 'ob-vt-lang';
	for (const t of transcript!.tracks) {
		const opt = document.createElement('option');
		opt.value = t.languageCode;
		opt.textContent = t.name + (t.isASR ? ' (auto)' : '');
		if (t.languageCode === transcript!.languageCode) opt.selected = true;
		sel.appendChild(opt);
	}
	sel.addEventListener('change', async () => {
		const lang = sel.value;
		setSessionLang(videoId, lang);
		const my = session;
		const next = await loadTranscript(videoId, lang);
		if (my !== session || !active || !next) return;
		transcript = next;
		renderTranscript();
		scrollToLookback();
	});
	// Hide the picker when there's only one track.
	if (transcript!.tracks.length < 2) sel.style.display = 'none';
	return sel;
}

function onFullscreenChange() {
	if (!root) return;
	const target = mountTarget();
	if (root.parentElement !== target) target.appendChild(root);
	positionRoot();
}

// --- Transcript rendering + highlight repaint --------------------------------

function escapeHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Build a cue span's innerHTML, wrapping any saved-highlight ranges that fall in
// this cue with <mark>. Ranges are assumed non-overlapping (typical); on overlap
// the later item wins for the contested characters.
function cueInnerHtml(cue: TranscriptCue): string {
	const text = cue.text;
	type Seg = { start: number; end: number; color: VideoColor; id: string };
	const segs: Seg[] = [];
	for (const item of saved) {
		const a = item.anchor!;
		if (cue.index < a.startCue || cue.index > a.endCue) continue;
		const s = cue.index === a.startCue ? a.startOffset : 0;
		const e = cue.index === a.endCue ? a.endOffset : text.length;
		if (e > s) segs.push({ start: Math.max(0, s), end: Math.min(text.length, e), color: item.color || 'yellow', id: item.id });
	}
	if (segs.length === 0) return escapeHtml(text) + ' ';
	segs.sort((x, y) => x.start - y.start);
	let html = '';
	let pos = 0;
	for (const seg of segs) {
		if (seg.start < pos) continue; // skip overlap
		if (seg.start > pos) html += escapeHtml(text.slice(pos, seg.start));
		html += `<mark class="ob-vt-hl ${seg.color}" data-item-id="${seg.id}">${escapeHtml(text.slice(seg.start, seg.end))}</mark>`;
		pos = seg.end;
	}
	if (pos < text.length) html += escapeHtml(text.slice(pos));
	return html + ' ';
}

function renderTranscript() {
	if (!listEl || !transcript) return;
	listEl.replaceChildren();
	const curCueIdx = currentCueIndex();
	for (const para of transcript.paragraphs) {
		const p = document.createElement('p');
		p.className = 'ob-vt-para';
		for (const cue of para.cues) {
			const span = document.createElement('span');
			span.className = 'ob-vt-cue' + (cue.index === curCueIdx ? ' is-now' : '');
			span.dataset.cue = String(cue.index);
			span.innerHTML = cueInnerHtml(cue);
			p.appendChild(span);
		}
		listEl.appendChild(p);
	}
}

function currentCueIndex(): number {
	if (!transcript) return -1;
	const cues = transcript.cues;
	for (let i = 0; i < cues.length; i++) {
		if (videoTime >= cues[i].start && videoTime < cues[i].end) return i;
		if (cues[i].start > videoTime) return Math.max(0, i - 1);
	}
	return cues.length - 1;
}

function scrollToLookback() {
	if (!listEl || !transcript) return;
	const target = Math.max(0, videoTime - LOOKBACK_SECONDS);
	let cueIdx = 0;
	for (let i = 0; i < transcript.cues.length; i++) {
		if (transcript.cues[i].start >= target) { cueIdx = i; break; }
		cueIdx = i;
	}
	const span = listEl.querySelector(`.ob-vt-cue[data-cue="${cueIdx}"]`) as HTMLElement | null;
	if (span) listEl.scrollTop = Math.max(0, span.offsetTop - listEl.clientHeight * 0.25);
}

// --- Selection → swatch popup ------------------------------------------------

function cueSpanOf(node: Node | null): HTMLElement | null {
	let el = (node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node as HTMLElement | null);
	return el ? (el.closest('.ob-vt-cue') as HTMLElement | null) : null;
}

// Character offset of (node, nodeOffset) within a cue span's full text.
function offsetWithinCue(span: HTMLElement, node: Node, nodeOffset: number): number {
	let offset = 0;
	const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
	let n: Node | null;
	while ((n = walker.nextNode())) {
		if (n === node) return offset + nodeOffset;
		offset += (n.textContent || '').length;
	}
	return offset;
}

function onSelectionEnd() {
	if (!active || isCommentsActive()) return;
	const sel = window.getSelection();
	if (!sel || sel.isCollapsed || sel.rangeCount === 0) { removePopup(); return; }
	const quote = sel.toString().trim();
	if (!quote) { removePopup(); return; }

	const range = sel.getRangeAt(0);
	let startSpan = cueSpanOf(range.startContainer);
	let endSpan = cueSpanOf(range.endContainer);
	if (!startSpan || !endSpan) { removePopup(); return; }

	let startCue = parseInt(startSpan.dataset.cue!);
	let endCue = parseInt(endSpan.dataset.cue!);
	let startOffset = offsetWithinCue(startSpan, range.startContainer, range.startOffset);
	let endOffset = offsetWithinCue(endSpan, range.endContainer, range.endOffset);
	if (startCue > endCue || (startCue === endCue && startOffset > endOffset)) {
		[startCue, endCue] = [endCue, startCue];
		[startOffset, endOffset] = [endOffset, startOffset];
	}
	pendingSel = { startCue, startOffset, endCue, endOffset, quote };
	showPopup(range.getBoundingClientRect());
}

function showPopup(rect: DOMRect) {
	removePopup();
	popupEl = document.createElement('div');
	popupEl.className = 'ob-vt-popup';
	const colors: VideoColor[] = ['yellow', 'red', 'green'];
	for (const c of colors) {
		const sw = document.createElement('button');
		sw.type = 'button';
		sw.className = 'ob-vid-swatch ' + c;
		sw.title = c;
		sw.addEventListener('mousedown', (e) => { e.preventDefault(); });
		sw.addEventListener('click', () => createHighlight(c, false));
		popupEl.appendChild(sw);
	}
	const sep = document.createElement('span');
	sep.className = 'ob-vid-toolsep';
	popupEl.appendChild(sep);
	const comment = document.createElement('button');
	comment.type = 'button';
	comment.className = 'ob-vt-popup-comment';
	comment.textContent = '💬 Comment';
	comment.addEventListener('mousedown', (e) => { e.preventDefault(); });
	comment.addEventListener('click', () => createHighlight('yellow', true));
	popupEl.appendChild(comment);

	mountTarget().appendChild(popupEl);
	const pr = popupEl.getBoundingClientRect();
	let left = rect.left + rect.width / 2 - pr.width / 2;
	let top = rect.top - pr.height - 8;
	left = Math.max(6, Math.min(left, window.innerWidth - pr.width - 6));
	if (top < 6) top = rect.bottom + 8;
	popupEl.style.left = `${left}px`;
	popupEl.style.top = `${top}px`;
}

function removePopup() {
	popupEl?.remove();
	popupEl = null;
}

async function createHighlight(color: VideoColor, thenComment: boolean) {
	if (!pendingSel || !transcript) return;
	const { startCue, startOffset, endCue, endOffset, quote } = pendingSel;
	const item: VideoItem = {
		id: genVideoId(),
		kind: 'transcript',
		videoTime: transcript.cues[startCue].start,
		timeEnd: transcript.cues[endCue].end,
		quote,
		color,
		anchor: { startCue, startOffset, endCue, endOffset },
		notes: [],
	};
	saved.push(item);
	await upsertVideoItem(watchUrl, videoId, videoTitle, item);

	pendingSel = null;
	removePopup();
	window.getSelection()?.removeAllRanges();
	renderTranscript();

	if (thenComment) openCommentFor(item.id);
}

// --- Comment hand-off --------------------------------------------------------

function onListDblClick(e: MouseEvent) {
	if (!active || isCommentsActive()) return;
	const mark = (e.target as HTMLElement).closest('.ob-vt-hl') as HTMLElement | null;
	if (!mark) return;
	const id = mark.dataset.itemId;
	if (id) { e.preventDefault(); openCommentFor(id); }
}

async function openCommentFor(itemId: string) {
	removePopup();
	window.getSelection()?.removeAllRanges();
	// Switch panels keeping the SAME frame on the left: mount the comment panel
	// (reusing our captured frame, no fade) so it covers the transcript panel,
	// then hide the transcript underneath. Only the right panel appears to change.
	await openComments({
		watchUrl, videoId, videoTitle, video,
		wasPlaying: false,        // the transcript panel owns resume
		focusItemId: itemId,
		resumeOnClose: false,
		frame: capturedFrame,
		switchMode: true,
		onClose: async () => {
			// Refresh saved highlights (a thread may now have content) and bring the
			// transcript panel back where it was.
			const data = await loadVideoData(watchUrl);
			saved = data ? data.items.filter(i => i.kind === 'transcript' && i.anchor) : saved;
			if (root) {
				root.style.display = '';
				positionRoot();
				renderTranscript();
			}
		},
	});
	if (root) root.style.display = 'none';
}

// --- Keyboard ----------------------------------------------------------------

function onKeyUpShield(e: KeyboardEvent) {
	if (!active) return;
	if ((e.target as HTMLElement)?.closest?.('.ob-vt-panel')) e.stopPropagation();
}

function onKeyDown(e: KeyboardEvent) {
	if (!active || isCommentsActive()) return;
	// Let the conversation panel handle keys when it's open on top.
	e.stopPropagation();
	if (e.key === 'Escape') { e.preventDefault(); if (popupEl) removePopup(); else teardown(); }
}

// --- Escape lock + teardown --------------------------------------------------

function lockEscape() {
	const kb = (navigator as unknown as { keyboard?: { lock?: (k: string[]) => Promise<void> } }).keyboard;
	if (openedFullscreen && kb?.lock) {
		try { kb.lock(['Escape'])?.catch(() => {}); } catch { /* ignore */ }
	}
}
function unlockEscape() {
	const kb = (navigator as unknown as { keyboard?: { unlock?: () => void } }).keyboard;
	if (kb?.unlock) { try { kb.unlock(); } catch { /* ignore */ } }
}

function toast(msg: string) {
	const el = document.createElement('div');
	el.className = 'ob-vid-toast';
	el.textContent = msg;
	mountTarget().appendChild(el);
	setTimeout(() => el.remove(), 2200);
}

function teardown() {
	setTimeout(unlockEscape, 400);
	window.removeEventListener('resize', positionRoot, true);
	window.removeEventListener('scroll', positionRoot, true);
	document.removeEventListener('fullscreenchange', onFullscreenChange, true);
	window.removeEventListener('keydown', onKeyDown, true);
	window.removeEventListener('keyup', onKeyUpShield, true);
	window.removeEventListener('keypress', onKeyUpShield, true);
	removePopup();

	if (root) {
		root.classList.add('is-closing');
		const el = root;
		setTimeout(() => el.remove(), 250);
	}
	root = listEl = null;
	pendingSel = null;

	const resume = wasPlaying;
	const vid = video;
	active = false;
	transcript = null;
	saved = [];
	capturedFrame = null;

	if (vid && resume) vid.play().catch(() => {});
}
