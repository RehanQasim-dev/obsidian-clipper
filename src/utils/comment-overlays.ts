import { AnyHighlightData, highlights, saveHighlights, updateHighlights } from './highlighter';
import { getElementByXPath } from './dom-utils';
import { textHighlightRanges } from './highlighter-overlays';

const COMMENT_BOX_WIDTH = 320;
const COMMENT_BOX_MARGIN = 20;
const COMMENT_BOX_GAP = 12;

let activeCommentBoxes = new Map<string, HTMLElement>();
let editingHighlightIds = new Set<string>();
let expandedCommentIndexes = new Set<string>(); // highlightId-index
let editingNoteKey: string | null = null; // highlightId-index
let singleClickTimer: number | null = null; // disambiguates single- vs double-click on a comment

// Last innerHTML rendered into each box. renderCommentBoxes() runs on every
// highlight mutation, storage sync, scroll-driven reapply, etc. Rebuilding
// innerHTML every time wipes an open editor (losing in-progress text + focus)
// and — worse — detaches the Save/Cancel buttons. If an async rebuild lands
// between a button's mousedown and mouseup, the click resolves on the box div
// instead of the button and the action silently no-ops. Skipping the rebuild
// when the rendered content is unchanged keeps the editor DOM stable so typing
// and saving work reliably. Keyed by box element so entries GC with the box.
const boxRenderCache = new WeakMap<HTMLElement, string>();

function parseNoteString(note: string): { text: string, timestamp?: number } {
	const match = note.match(/([\s\S]*?)(?:<!--timestamp:(\d+)-->)?$/);
	return {
		text: match ? match[1].trim() : note.trim(),
		timestamp: match && match[2] ? parseInt(match[2]) : undefined
	};
}

function formatTime(ts: number): string {
	const d = new Date(ts);
	return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getHighlightTopPosition(highlight: AnyHighlightData): number | null {
	if (highlight.type === 'text') {
		const ranges = textHighlightRanges.get(highlight.id);
		if (ranges && ranges.length > 0) {
			const rects = ranges[0].getClientRects();
			if (rects.length > 0) {
				let top = Infinity;
				for (let i = 0; i < rects.length; i++) {
					if (rects[i].top < top) top = rects[i].top;
				}
				return top + window.scrollY;
			}
		}
	} else {
		const target = getElementByXPath(highlight.xpath);
		if (target) {
			return target.getBoundingClientRect().top + window.scrollY;
		}
	}
	return null;
}

function getHighlightBlockRect(highlight: AnyHighlightData): DOMRect | null {
	let target: Element | null = null;
	if (highlight.type === 'text') {
		const ranges = textHighlightRanges.get(highlight.id);
		if (ranges && ranges.length > 0) {
			target = ranges[0].commonAncestorContainer as Element;
			if (target.nodeType === Node.TEXT_NODE) {
				target = target.parentElement;
			}
		}
	} else {
		target = getElementByXPath(highlight.xpath);
	}

	if (!target) return null;

	while (target && target !== document.body && target !== document.documentElement) {
		const style = window.getComputedStyle(target);
		const display = style.display;
		if (display === 'block' || display === 'flex' || display === 'grid' || display === 'table' || display === 'list-item') {
			return target.getBoundingClientRect();
		}
		target = target.parentElement;
	}
	
	return target ? target.getBoundingClientRect() : null;
}

export function startAddingComment(highlightId: string) {
	editingHighlightIds.add(highlightId);
	renderCommentBoxes();
	
	// Defer focus slightly so that browser events (like mouseup/click resolution) don't steal focus
	setTimeout(() => {
		const box = activeCommentBoxes.get(highlightId);
		if (box) {
			const textarea = box.querySelector('textarea');
			if (textarea) {
				textarea.focus({ preventScroll: true });
				autosizeTextarea(textarea);
			}
		}
	}, 50);
}

export function stopAddingComment(highlightId: string) {
	editingHighlightIds.delete(highlightId);
	renderCommentBoxes();
}

export function renderCommentBoxes() {
	// Reset padding first to get true un-padded coordinates
	document.body.style.paddingLeft = '';
	document.body.style.paddingRight = '';

	const highlightsWithComments = highlights.filter(h => 
		(h.notes && h.notes.length > 0) || editingHighlightIds.has(h.id)
	);

	if (highlightsWithComments.length === 0) {
		return;
	}

	const newActiveBoxes = new Map<string, HTMLElement>();
	const leftLayoutItems: { id: string, top: number, height: number, el: HTMLElement }[] = [];
	const rightLayoutItems: { id: string, top: number, height: number, el: HTMLElement }[] = [];

	let maxLeftDeficit = 0;
	let maxRightDeficit = 0;
	const spaceNeeded = COMMENT_BOX_WIDTH + COMMENT_BOX_MARGIN * 2;

	for (const highlight of highlightsWithComments) {
		let box = activeCommentBoxes.get(highlight.id);
		if (!box) {
			box = createCommentBox(highlight);
			document.body.appendChild(box);
		} else {
			updateCommentBox(box, highlight);
		}
		newActiveBoxes.set(highlight.id, box);

		// Temporarily set position to get accurate offsetHeight
		box.style.top = '0px'; 
		const boxHeight = box.offsetHeight;

		const rect = getHighlightBlockRect(highlight);
		const top = rect ? rect.top + window.scrollY : (getHighlightTopPosition(highlight) ?? 0);
		
		let side = 'right';
		let availableLeft = 0;
		let availableRight = 0;

		if (rect) {
			availableLeft = rect.left;
			availableRight = window.innerWidth - rect.right;
			
			// If left has more space and enough space for a box, use left. Otherwise default right.
			if (availableLeft > availableRight && availableLeft >= spaceNeeded) {
				side = 'left';
			} else if (availableRight < spaceNeeded && availableLeft > availableRight) {
				// Even if neither has enough, pick the one with more space to minimize shift
				side = 'left';
			}
		}

		if (side === 'left') {
			const deficit = spaceNeeded - availableLeft;
			if (deficit > maxLeftDeficit) maxLeftDeficit = deficit;
			leftLayoutItems.push({ id: highlight.id, top, height: boxHeight, el: box });
		} else {
			const deficit = spaceNeeded - availableRight;
			if (deficit > maxRightDeficit) maxRightDeficit = deficit;
			rightLayoutItems.push({ id: highlight.id, top, height: boxHeight, el: box });
		}
	}

	if (maxLeftDeficit > 0) {
		document.body.style.paddingLeft = `${maxLeftDeficit}px`;
	}
	if (maxRightDeficit > 0) {
		document.body.style.paddingRight = `${maxRightDeficit}px`;
	}

	// Remove old boxes
	for (const [id, box] of activeCommentBoxes.entries()) {
		if (!newActiveBoxes.has(id)) {
			box.remove();
		}
	}
	activeCommentBoxes = newActiveBoxes;

	// Layout resolution for Left
	leftLayoutItems.sort((a, b) => a.top - b.top);
	let currentYLeft = 0;
	for (const item of leftLayoutItems) {
		const targetY = item.top;
		const actualY = Math.max(currentYLeft, targetY);
		item.el.style.top = `${actualY}px`;
		item.el.style.left = `${COMMENT_BOX_MARGIN}px`;
		item.el.style.right = 'auto';
		currentYLeft = actualY + item.height + COMMENT_BOX_GAP;
	}

	// Layout resolution for Right
	rightLayoutItems.sort((a, b) => a.top - b.top);
	let currentYRight = 0;
	for (const item of rightLayoutItems) {
		const targetY = item.top;
		const actualY = Math.max(currentYRight, targetY);
		item.el.style.top = `${actualY}px`;
		item.el.style.right = `${COMMENT_BOX_MARGIN}px`;
		item.el.style.left = 'auto';
		currentYRight = actualY + item.height + COMMENT_BOX_GAP;
	}

	// Determine overflow for collapsed comments to show gradient
	requestAnimationFrame(() => {
		activeCommentBoxes.forEach(box => {
			box.querySelectorAll('.obsidian-comment-text.is-collapsed').forEach(el => {
				if (el.scrollHeight > el.clientHeight) {
					el.classList.add('has-overflow');
				} else {
					el.classList.remove('has-overflow');
				}
			});
		});
	});
}

// Grow a textarea to fit its content so the whole comment is visible without
// an inner scrollbar while typing.
function autosizeTextarea(ta: HTMLTextAreaElement) {
	ta.style.height = 'auto';
	ta.style.height = `${ta.scrollHeight}px`;
}

// Wrap (or insert markers around) the current selection for Cmd/Ctrl+B / +I.
// With no selection, drops empty markers and parks the caret between them.
function wrapSelection(ta: HTMLTextAreaElement, marker: string) {
	const { selectionStart: s, selectionEnd: e, value } = ta;
	const selected = value.slice(s, e);
	ta.value = value.slice(0, s) + marker + selected + marker + value.slice(e);
	if (selected) {
		ta.setSelectionRange(s + marker.length, e + marker.length);
	} else {
		ta.setSelectionRange(s + marker.length, s + marker.length);
	}
}

// editingNoteKey is `${highlightId}-${index}`. Highlight ids never contain '-'
// (they're timestamps or `<ts>_tx_<n>` style), so split on the last dash.
function parseNoteKey(key: string): { highlightId: string; index: number } {
	const dash = key.lastIndexOf('-');
	return { highlightId: key.slice(0, dash), index: parseInt(key.slice(dash + 1)) };
}

// Render a small, safe subset of inline markdown in *displayed* comments:
// [text](http(s) url), **bold**, *italic*. Input is already HTML-escaped, so
// only the tags we emit here are live HTML. Links are restricted to http(s).
function renderInlineMarkdown(escaped: string): string {
	return escaped
		.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>');
}

// After entering edit mode, size the editor to the full comment, focus it, and
// drop the caret at the end so the user types after the last character.
function focusEditTextarea(highlightId: string) {
	setTimeout(() => {
		const box = activeCommentBoxes.get(highlightId);
		if (!box) return;
		const ta = box.querySelector('.edit-comment-textarea') as HTMLTextAreaElement | null;
		if (!ta) return;
		autosizeTextarea(ta);
		ta.focus({ preventScroll: true });
		const end = ta.value.length;
		ta.setSelectionRange(end, end);
	}, 0);
}

function createCommentBox(highlight: AnyHighlightData): HTMLElement {
	const box = document.createElement('div');
	box.className = 'obsidian-comment-box';
	box.dataset.highlightId = highlight.id;
	box.style.width = `${COMMENT_BOX_WIDTH}px`;
	
	updateCommentBox(box, highlight);
	
	// Add event delegation for save/delete actions
	box.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		if (target.closest('.obsidian-comment-save')) {
			const textarea = box.querySelector('textarea.new-comment-textarea') as HTMLTextAreaElement;
			if (textarea) {
				const text = textarea.value.trim();
				saveComment(highlight.id, text);
			}
		} else if (target.closest('.obsidian-comment-save-edit')) {
			const textarea = box.querySelector('textarea.edit-comment-textarea') as HTMLTextAreaElement;
			if (textarea && editingNoteKey) {
				const { highlightId, index } = parseNoteKey(editingNoteKey);
				saveEditedComment(highlightId, index, textarea.value.trim());
			}
		} else if (target.closest('.obsidian-comment-cancel')) {
			stopAddingComment(highlight.id);
		} else if (target.closest('.obsidian-comment-cancel-edit')) {
			editingNoteKey = null;
			renderCommentBoxes();
		} else if (target.closest('.obsidian-comment-edit')) {
			const noteIndex = parseInt((target.closest('.obsidian-comment-edit') as HTMLElement).dataset.index || '0');
			editingNoteKey = `${highlight.id}-${noteIndex}`;
			renderCommentBoxes();
			focusEditTextarea(highlight.id);
		} else if (target.closest('.obsidian-comment-delete')) {
			const noteIndex = parseInt((target.closest('.obsidian-comment-delete') as HTMLElement).dataset.index || '0');
			deleteComment(highlight.id, noteIndex);
		} else if (target.closest('.obsidian-comment-text')) {
			const textEl = target.closest('.obsidian-comment-text') as HTMLElement;
			const noteIndex = textEl.dataset.index;
			const expandKey = `${highlight.id}-${noteIndex}`;
			// A double-click always fires two `click` events first. Defer the
			// expand/collapse so the dblclick handler (edit mode) can cancel it —
			// otherwise a single click would toggle expansion under the edit.
			if (singleClickTimer) clearTimeout(singleClickTimer);
			singleClickTimer = window.setTimeout(() => {
				singleClickTimer = null;
				if (expandedCommentIndexes.has(expandKey)) {
					expandedCommentIndexes.delete(expandKey);
				} else if (textEl.classList.contains('has-overflow')) {
					// Only expand if it actually overflows
					expandedCommentIndexes.add(expandKey);
				}
				renderCommentBoxes();
			}, 250);
		}
	});

	box.addEventListener('mouseenter', () => showActiveRing(highlight.id));
	box.addEventListener('mouseleave', () => hideActiveRing());

	box.addEventListener('dblclick', (e) => {
		const target = e.target as HTMLElement;
		const textEl = target.closest('.obsidian-comment-text') as HTMLElement;
		if (textEl) {
			// Cancel the pending single-click expand/collapse so a double-click
			// only enters edit mode.
			if (singleClickTimer) {
				clearTimeout(singleClickTimer);
				singleClickTimer = null;
			}
			const noteIndex = textEl.dataset.index;
			if (noteIndex !== undefined) {
				editingNoteKey = `${highlight.id}-${noteIndex}`;
				expandedCommentIndexes.add(editingNoteKey);
				renderCommentBoxes();
				focusEditTextarea(highlight.id);
			}
		}
	});

	// Keep the editor sized to its content as the user types.
	box.addEventListener('input', (e) => {
		const ta = e.target as HTMLElement;
		if (ta instanceof HTMLTextAreaElement &&
			(ta.classList.contains('edit-comment-textarea') || ta.classList.contains('new-comment-textarea'))) {
			autosizeTextarea(ta);
		}
	});

	// Editor keyboard shortcuts: Escape commits the comment (delete uses the
	// trash button), Cmd/Ctrl+B / +I wrap the selection in markdown.
	box.addEventListener('keydown', (e) => {
		const ta = e.target;
		if (!(ta instanceof HTMLTextAreaElement)) return;
		const isNew = ta.classList.contains('new-comment-textarea');
		const isEdit = ta.classList.contains('edit-comment-textarea');
		if (!isNew && !isEdit) return;

		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation(); // don't let highlighter mode exit on Escape
			if (isNew) {
				saveComment(highlight.id, ta.value.trim());
			} else if (editingNoteKey) {
				const { highlightId, index } = parseNoteKey(editingNoteKey);
				saveEditedComment(highlightId, index, ta.value.trim());
			}
			return;
		}

		if ((e.ctrlKey || e.metaKey) && (e.key === 'b' || e.key === 'i' || e.key === 'B' || e.key === 'I')) {
			e.preventDefault();
			wrapSelection(ta, e.key.toLowerCase() === 'b' ? '**' : '*');
			autosizeTextarea(ta);
		}
	});

	return box;
}

function updateCommentBox(box: HTMLElement, highlight: AnyHighlightData) {
	const notes = highlight.notes || [];
	const isEditing = editingHighlightIds.has(highlight.id);
	
	let html = '';
	
	if (notes.length > 0) {
		html += `<div class="obsidian-comment-list">`;
		notes.forEach((note, index) => {
			const isExpanded = expandedCommentIndexes.has(`${highlight.id}-${index}`);
			const isEditingThisNote = editingNoteKey === `${highlight.id}-${index}`;
			const parsed = parseNoteString(note);
			const timeHtml = parsed.timestamp ? `<div class="obsidian-comment-timestamp">${formatTime(parsed.timestamp)}</div>` : '<div></div>';
			
			let displayHtml = escapeHtml(parsed.text);
			displayHtml = renderInlineMarkdown(displayHtml);
			// Require a boundary before '#' so it tags real hashtags but not the
			// fragment in a URL like http://x#section.
			displayHtml = displayHtml.replace(/(^|\s)(#[a-zA-Z0-9_-]+)/g, '$1<span class="obsidian-inline-tag">$2</span>');

			if (isEditingThisNote) {
				html += `
					<div class="obsidian-comment-item">
						<div class="obsidian-comment-editor">
							<textarea class="edit-comment-textarea" rows="3">${escapeHtml(parsed.text)}</textarea>
							<div class="obsidian-comment-actions">
								<button class="obsidian-comment-cancel-edit">Cancel</button>
								<button class="obsidian-comment-save-edit mod-cta">Save</button>
							</div>
						</div>
					</div>
				`;
			} else {
				html += `
					<div class="obsidian-comment-item">
						<div class="obsidian-comment-item-header">
							<div class="obsidian-comment-text ${isExpanded ? '' : 'is-collapsed'}" data-index="${index}">${displayHtml}</div>
						</div>
						<div class="obsidian-comment-item-footer">
							${timeHtml}
							<div class="obsidian-comment-actions-inline">
								<button class="obsidian-comment-edit" data-index="${index}" aria-label="Edit comment">
									<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
								</button>
								<button class="obsidian-comment-delete" data-index="${index}" aria-label="Delete comment">
									<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
								</button>
							</div>
						</div>
					</div>
				`;
			}
		});
		html += `</div>`;
	}

	if (isEditing) {
		html += `
			<div class="obsidian-comment-editor">
				<textarea class="new-comment-textarea" placeholder="Add a comment..." rows="3"></textarea>
				<div class="obsidian-comment-actions">
					<button class="obsidian-comment-cancel">Cancel</button>
					<button class="obsidian-comment-save mod-cta">Save</button>
				</div>
			</div>
		`;
	} else if (!editingNoteKey?.startsWith(highlight.id + '-')) {
		html += `
			<button class="obsidian-comment-add-more" onclick="window.dispatchEvent(new CustomEvent('obsidian-add-comment', {detail: '${highlight.id}'}))">
				Add reply...
			</button>
		`;
	}

	// Only touch the DOM when the rendered content actually changed. An open
	// editor's textarea value (and the add-comment editor's emptiness) is not
	// part of `html`, so skipping the rebuild preserves whatever the user has
	// typed and keeps the Save/Cancel buttons attached across re-renders.
	if (boxRenderCache.get(box) === html) return;
	boxRenderCache.set(box, html);
	box.innerHTML = html;
}

window.addEventListener('obsidian-add-comment', ((e: CustomEvent) => {
	startAddingComment(e.detail);
}) as EventListener);

function saveComment(highlightId: string, text: string) {
	// Guard against double-fire: the editor only exists while the id is in the
	// editing set. Once we've saved (which clears it), a stray repeat click
	// must not push the same note again.
	if (!editingHighlightIds.has(highlightId)) return;

	if (!text) {
		stopAddingComment(highlightId);
		return;
	}
	
	const formattedText = `${text}<!--timestamp:${Date.now()}-->`;
	
	const highlight = highlights.find(h => h.id === highlightId);
	if (highlight) {
		if (!highlight.notes) highlight.notes = [];
		highlight.notes.push(formattedText);
		// Update global highlights array
		const newHighlights = highlights.map(h => h.id === highlightId ? highlight : h);
		updateHighlights(newHighlights);
		saveHighlights();
	}
	stopAddingComment(highlightId);
}

function saveEditedComment(highlightId: string, index: number, text: string) {
	editingNoteKey = null;
	if (!text) {
		renderCommentBoxes();
		return;
	}
	
	const highlight = highlights.find(h => h.id === highlightId);
	if (highlight && highlight.notes) {
		const oldParsed = parseNoteString(highlight.notes[index]);
		const ts = oldParsed.timestamp || Date.now();
		highlight.notes[index] = `${text}<!--timestamp:${ts}-->`;
		
		const newHighlights = highlights.map(h => h.id === highlightId ? highlight : h);
		updateHighlights(newHighlights);
		saveHighlights();
		renderCommentBoxes();
	}
}

function deleteComment(highlightId: string, index: number) {
	const highlight = highlights.find(h => h.id === highlightId);
	if (highlight && highlight.notes) {
		highlight.notes.splice(index, 1);
		const newHighlights = highlights.map(h => h.id === highlightId ? highlight : h);
		updateHighlights(newHighlights);
		saveHighlights();
		hideActiveRing(); // Hide the ring in case the comment box is completely removed
		renderCommentBoxes();
	}
}

export function clearCommentBoxes() {
	activeCommentBoxes.forEach(box => box.remove());
	activeCommentBoxes.clear();
	document.body.style.paddingRight = '';
	document.body.style.paddingLeft = '';
	hideActiveRing();
}

// Emphasize the comment box tied to a highlight (e.g. while hovering that
// highlight's text) so it's visually distinguishable from the other boxes.
// Pass null to clear. Guarded so we only touch the DOM on an actual change.
let emphasizedBoxId: string | null = null;
export function emphasizeCommentBox(highlightId: string | null) {
	if (emphasizedBoxId === highlightId) return;
	if (emphasizedBoxId) {
		activeCommentBoxes.get(emphasizedBoxId)?.classList.remove('is-active');
	}
	emphasizedBoxId = highlightId;
	if (highlightId) {
		activeCommentBoxes.get(highlightId)?.classList.add('is-active');
	}
}

let activeRings: HTMLDivElement[] = [];

function showActiveRing(highlightId: string) {
	hideActiveRing();
	const highlight = highlights.find(h => h.id === highlightId);
	if (!highlight) return;

	let rects: DOMRect[] = [];
	if (highlight.type === 'text') {
		const ranges = textHighlightRanges.get(highlightId);
		if (ranges && ranges.length > 0) {
			rects = Array.from(ranges[0].getClientRects());
		}
	} else {
		const target = getElementByXPath(highlight.xpath);
		if (target) {
			rects = [target.getBoundingClientRect()];
		}
	}

	const PAD = 2;
	for (let i = 0; i < rects.length; i++) {
		const rect = rects[i];
		let ring = activeRings[i];
		if (!ring) {
			ring = document.createElement('div');
			ring.className = 'obsidian-highlight-active-ring';
			document.body.appendChild(ring);
			activeRings.push(ring);
		}
		ring.style.display = 'block';
		ring.style.left = `${rect.left + window.scrollX - PAD}px`;
		ring.style.top = `${rect.top + window.scrollY - PAD}px`;
		ring.style.width = `${rect.width + PAD * 2}px`;
		ring.style.height = `${rect.height + PAD * 2}px`;
	}
}

function hideActiveRing() {
	activeRings.forEach(ring => ring.style.display = 'none');
}

function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}
