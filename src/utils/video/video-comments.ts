import {
	VideoItem, loadVideoData, upsertVideoItem,
} from './video-storage';
import { renderMarkupSvg } from './video-markup';
import { makeVideoNote, parseVideoNote, renderNoteHtml, formatVideoTime } from './video-notes';
import { getVideoElement } from './youtube-detect';
import { engagePlayerStage, mountHost, unmountHost, disengagePlayerStage } from './video-player-stage';

// Per-video "conversation" comment panel: a right-docked overlay listing every
// annotation for the video (frame / note / transcript) as grouped thread cards
// — one card = one item's anchor + all its replies — with the focused thread
// expanded and its reply box active. Shared by the frame/note flows
// (video-annotator) and the transcript panel. Reuses the .ob-vid-* slate styles.
//
// Opened either standalone (resumeOnClose: resumes the video on Esc) or nested
// inside the transcript panel (onClose returns there; the panel keeps the video
// paused).

export interface OpenCommentsOpts {
	watchUrl: string;
	videoId: string;
	videoTitle: string;
	video: HTMLVideoElement | null;
	wasPlaying: boolean;
	focusItemId?: string;
	resumeOnClose: boolean;
	onClose?: () => void;
	// A freshly-created item (e.g. a new note/frame) not yet persisted; included
	// in the list and written on first reply.
	ensureItem?: VideoItem;
	// During a panel switch (transcript ↔ comment) the player is already scaled and
	// stays put; switchMode just drops the open fade-in so only the panel changes.
	switchMode?: boolean;
}

let active = false;
let opts: OpenCommentsOpts | null = null;
let items: VideoItem[] = [];
let focusId: string | null = null;

let root: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let inputEl: HTMLTextAreaElement | null = null;
let openedFullscreen = false;

export function isCommentsActive(): boolean {
	return active;
}

export async function openComments(o: OpenCommentsOpts): Promise<void> {
	if (active) return;
	opts = o;
	active = true;
	openedFullscreen = !!document.fullscreenElement;

	const data = await loadVideoData(o.watchUrl);
	items = data ? data.items.slice() : [];
	if (o.ensureItem && !items.some(i => i.id === o.ensureItem!.id)) {
		items.push(o.ensureItem);
	}
	items.sort((a, b) => a.videoTime - b.videoTime);
	focusId = o.focusItemId || (items.length ? items[items.length - 1].id : null);

	if (o.video) o.video.pause();
	build();
}

// --- Layout ------------------------------------------------------------------
// The live player is scaled to the left by the shared player stage; this panel
// just fills the host the stage docks on the right.

function build() {
	engagePlayerStage();
	root = document.createElement('div');
	root.className = 'ob-vidc-host' + (opts?.switchMode ? ' ob-vid-noanim' : '');

	const head = document.createElement('div');
	head.className = 'ob-vid-panel-head';
	const title = document.createElement('span');
	title.className = 'ob-vid-panel-time';
	title.textContent = 'Comments';
	const close = document.createElement('button');
	close.type = 'button';
	close.className = 'ob-vid-panel-close';
	close.title = 'Close (Esc)';
	close.textContent = '✕';
	close.addEventListener('click', () => teardown());
	head.appendChild(title);
	head.appendChild(close);

	listEl = document.createElement('div');
	listEl.className = 'ob-vid-msgs ob-vidc-conv';

	root.appendChild(head);
	root.appendChild(listEl);
	mountHost(root);

	renderConversation();

	window.addEventListener('keydown', onKeyDown, true);
	window.addEventListener('keyup', onKeyUpShield, true);
	window.addEventListener('keypress', onKeyUpShield, true);
}

// --- Rendering ---------------------------------------------------------------

function anchorHeader(item: VideoItem): HTMLElement {
	const head = document.createElement('div');
	head.className = 'ob-vidc-anchor';
	const stamp = item.kind === 'transcript' && item.timeEnd != null
		? `${formatVideoTime(item.videoTime)}–${formatVideoTime(item.timeEnd)}`
		: formatVideoTime(item.videoTime);

	if (item.kind === 'frame' && item.frame) {
		const thumb = document.createElement('div');
		thumb.className = 'ob-vidc-thumb';
		const img = document.createElement('img');
		img.src = item.frame.dataUrl;
		thumb.appendChild(img);
		if (item.markup) {
			const ov = document.createElement('div');
			ov.className = 'ob-vidc-thumb-markup';
			ov.appendChild(renderMarkupSvg(item.markup, item.frame.w, item.frame.h));
			thumb.appendChild(ov);
		}
		head.appendChild(thumb);
	} else if (item.kind === 'transcript' && item.quote) {
		const q = document.createElement('div');
		q.className = 'ob-vidc-quote' + (item.color ? ' ' + item.color : '');
		q.textContent = item.quote;
		head.appendChild(q);
	}

	const chip = document.createElement('span');
	chip.className = 'ob-vidc-stamp';
	chip.textContent = stamp;
	chip.title = 'Seek to this moment';
	chip.addEventListener('click', () => seekTo(item.videoTime));
	head.appendChild(chip);
	return head;
}

function renderConversation() {
	if (!listEl) return;
	listEl.replaceChildren();
	if (items.length === 0) {
		const empty = document.createElement('div');
		empty.className = 'ob-vidc-empty';
		empty.textContent = 'No comments yet.';
		listEl.appendChild(empty);
		return;
	}

	for (const item of items) {
		const card = document.createElement('div');
		card.className = 'ob-vidc-thread' + (item.id === focusId ? ' is-focused' : '');
		card.dataset.itemId = item.id;
		card.addEventListener('click', (e) => {
			if (item.id === focusId) return;
			// Ignore clicks that originate in the (focused) input row.
			if ((e.target as HTMLElement).closest('.ob-vidc-replywrap')) return;
			focusId = item.id;
			renderConversation();
		});

		card.appendChild(anchorHeader(item));

		const msgs = document.createElement('div');
		msgs.className = 'ob-vidc-msgs';
		for (const note of item.notes) {
			const parsed = parseVideoNote(note);
			const bubble = document.createElement('div');
			bubble.className = 'ob-vid-msg';
			const body = document.createElement('div');
			body.className = 'ob-vid-msg-body';
			body.innerHTML = renderNoteHtml(parsed.text);
			bubble.appendChild(body);
			requestAnimationFrame(() => {
				if (body.scrollHeight - body.clientHeight > 4) {
					bubble.classList.add('is-collapsible');
					const more = document.createElement('button');
					more.type = 'button';
					more.className = 'ob-vid-msg-more';
					more.textContent = 'Show more';
					more.addEventListener('click', (ev) => {
						ev.stopPropagation();
						const open = bubble.classList.toggle('is-open');
						more.textContent = open ? 'Show less' : 'Show more';
					});
					bubble.appendChild(more);
				}
			});
			msgs.appendChild(bubble);
		}
		card.appendChild(msgs);

		// The focused thread carries the reply box, with the anchor quote pinned
		// above it (WhatsApp-style) for transcript items.
		if (item.id === focusId) {
			// The thread's quote already sits in the anchor header at the top of this
			// same card, so we don't repeat it above the input.
			const wrap = document.createElement('div');
			wrap.className = 'ob-vid-input-wrap ob-vidc-replywrap';
			inputEl = document.createElement('textarea');
			inputEl.className = 'ob-vid-input';
			inputEl.rows = 1;
			inputEl.placeholder = 'reply here';
			inputEl.addEventListener('input', autosizeInput);
			wrap.appendChild(inputEl);
			card.appendChild(wrap);
		}

		listEl.appendChild(card);
	}

	// Bring the focused thread's reply box into view and focus it, so you can type
	// immediately without scrolling.
	const focused = listEl.querySelector('.ob-vidc-thread.is-focused') as HTMLElement | null;
	setTimeout(() => {
		if (inputEl) {
			inputEl.scrollIntoView({ block: 'center' });
			inputEl.focus({ preventScroll: true });
		} else if (focused) {
			focused.scrollIntoView({ block: 'nearest' });
		}
	}, 60);
}

function autosizeInput() {
	if (!inputEl) return;
	inputEl.style.height = 'auto';
	inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
}

async function postMessage() {
	if (!inputEl || !opts) return;
	const text = inputEl.value.trim();
	if (!text) return;
	const item = items.find(i => i.id === focusId);
	if (!item) return;
	item.notes.push(makeVideoNote(text, Date.now()));
	inputEl.value = '';
	autosizeInput();
	await upsertVideoItem(opts.watchUrl, opts.videoId, opts.videoTitle, item);
	renderConversation();
}

function seekTo(seconds: number) {
	const v = opts?.video || getVideoElement();
	if (v) { try { v.currentTime = Math.max(0, seconds); } catch { /* ignore */ } }
}

// --- Keyboard ----------------------------------------------------------------

function onKeyUpShield(e: KeyboardEvent) {
	if (!active) return;
	if ((e.target as HTMLElement)?.classList?.contains('ob-vid-input')) e.stopPropagation();
}

function onKeyDown(e: KeyboardEvent) {
	if (!active) return;
	const inChat = !!(e.target as HTMLElement)?.classList?.contains('ob-vid-input');
	if (inChat) {
		// Typing: shield everything from YouTube's shortcuts (Space, etc.).
		e.stopPropagation();
		if (e.key === 'Escape') { e.preventDefault(); teardown(); }
		else if (e.key === 'Enter' && !e.shiftKey) { 
			if (e.isComposing) return;
			e.preventDefault(); 
			postMessage(); 
		}
		return;
	}
	// Not typing: only claim Escape; let every other key reach YouTube (Space →
	// play/pause, etc.) so its shortcuts keep working behind the panel.
	if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); teardown(); }
}

// --- Teardown ----------------------------------------------------------------

function teardown() {
	const o = opts;
	window.removeEventListener('keydown', onKeyDown, true);
	window.removeEventListener('keyup', onKeyUpShield, true);
	window.removeEventListener('keypress', onKeyUpShield, true);

	if (root) unmountHost(root);
	disengagePlayerStage();
	root = listEl = inputEl = null;
	active = false;
	items = [];
	focusId = null;
	opts = null;

	if (o?.resumeOnClose && o.wasPlaying && o.video) o.video.play().catch(() => {});
	o?.onClose?.();
}
