import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { VideoItem } from '../utils/video/video-storage';
import { renderMarkupSvg } from '../utils/video/video-markup';
import { parseVideoNote, renderNoteHtml, formatVideoTime } from '../utils/video/video-notes';

dayjs.extend(relativeTime);

// Dashboard render path for a single video annotation item — a captured frame
// (with its markup repainted on top) or a frameless timestamped note, plus its
// chat thread. Built to match the marker-ink dashboard aesthetic. Returns the
// full `.highlight-item` element so it slots into the existing render pipeline.

export function createVideoItemCard(
	item: VideoItem,
	pageUrl: string,
	onDelete: (item: VideoItem) => void,
): HTMLElement {
	const el = document.createElement('div');
	el.className = 'highlight-item video-item';
	el.dataset.unitKey = item.id;

	// "Open at this moment" — YouTube honors &t=<seconds>s.
	const atUrl = `${pageUrl}${pageUrl.includes('?') ? '&' : '?'}t=${Math.floor(item.videoTime)}s`;
	const stamp = formatVideoTime(item.videoTime);

	if (item.kind === 'frame' && item.frame) {
		const fig = document.createElement('div');
		fig.className = 'video-frame-card';

		const img = document.createElement('img');
		img.className = 'video-frame-img';
		img.src = item.frame.dataUrl;
		img.loading = 'lazy';
		fig.appendChild(img);

		// Markup repainted over the frame at the frame's natural size; the SVG
		// stretches with the image via CSS.
		if (item.markup) {
			const overlay = document.createElement('div');
			overlay.className = 'video-frame-overlay';
			overlay.appendChild(renderMarkupSvg(item.markup, item.frame.w, item.frame.h));
			fig.appendChild(overlay);
		}

		const badge = document.createElement('a');
		badge.className = 'video-time-badge';
		badge.href = atUrl;
		badge.target = '_blank';
		badge.rel = 'noopener noreferrer';
		badge.textContent = stamp;
		badge.title = 'Open at this moment';
		fig.appendChild(badge);

		el.appendChild(fig);
	} else if (item.kind === 'transcript' && item.quote) {
		// Transcript highlight: a colored quote block + a M:SS–M:SS range badge.
		const block = document.createElement('div');
		block.className = 'video-transcript-card' + (item.color ? ' ' + item.color : '');

		const quote = document.createElement('blockquote');
		quote.className = 'video-transcript-quote';
		quote.textContent = item.quote;
		block.appendChild(quote);

		const badge = document.createElement('a');
		badge.className = 'video-time-badge';
		badge.href = atUrl;
		badge.target = '_blank';
		badge.rel = 'noopener noreferrer';
		badge.textContent = item.timeEnd != null ? `${stamp}–${formatVideoTime(item.timeEnd)}` : stamp;
		badge.title = 'Open at this moment';
		block.appendChild(badge);

		el.appendChild(block);
	} else {
		// Frameless note: a quiet timestamp chip linking to the moment.
		const chip = document.createElement('a');
		chip.className = 'video-note-stamp';
		chip.href = atUrl;
		chip.target = '_blank';
		chip.rel = 'noopener noreferrer';
		chip.textContent = stamp;
		chip.title = 'Open at this moment';
		el.appendChild(chip);
	}

	// Chat thread, styled like the page-highlight comment thread.
	if (item.notes.length > 0) {
		const thread = document.createElement('div');
		thread.className = 'highlight-comment-thread';
		for (const note of item.notes) {
			const parsed = parseVideoNote(note);
			const container = document.createElement('div');
			container.className = 'highlight-item-note-container';
			if (parsed.timestamp) {
				const time = document.createElement('div');
				time.className = 'highlight-item-time';
				time.style.marginBottom = '4px';
				time.textContent = dayjs(parsed.timestamp).fromNow();
				container.appendChild(time);
			}
			const body = document.createElement('div');
			body.className = 'highlight-item-note';
			body.innerHTML = renderNoteHtml(parsed.text);
			container.appendChild(body);
			thread.appendChild(container);
		}
		el.appendChild(thread);
	}

	// Hover-only delete (mirrors the highlight action row).
	const actions = document.createElement('div');
	actions.className = 'highlight-item-actions-container';
	const inner = document.createElement('div');
	inner.className = 'highlight-item-actions';
	const del = document.createElement('button');
	del.className = 'highlight-action-btn clickable-icon';
	del.title = 'Delete';
	const icon = document.createElement('i');
	icon.setAttribute('data-lucide', 'trash-2');
	del.appendChild(icon);
	del.addEventListener('click', () => onDelete(item));
	inner.appendChild(del);
	actions.appendChild(inner);
	el.appendChild(actions);

	return el;
}
