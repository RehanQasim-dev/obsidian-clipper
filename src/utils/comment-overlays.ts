import { AnyHighlightData, highlights, saveHighlights, updateHighlights } from './highlighter';
import { getElementByXPath } from './dom-utils';
import { textHighlightRanges, setActiveHighlight } from './highlighter-overlays';

const COMMENT_BOX_WIDTH = 320;
const COMMENT_BOX_MARGIN = 20;
const COMMENT_BOX_GAP = 12;

let activeCommentBoxes = new Map<string, HTMLElement>();
let editingHighlightIds = new Set<string>();
let focusedHighlightId: string | null = null;
let expandedCommentIndexes = new Set<string>(); // highlightId-index
let editingNoteKey: string | null = null; // highlightId-index
let singleClickTimer: number | null = null; // disambiguates single- vs double-click on a comment

browser.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && changes.diagrams) {
		const newDiagrams = changes.diagrams.newValue || {};
		let updated = false;
		for (const [id, data] of Object.entries(newDiagrams)) {
			if ((data as any).dataUrl && localDiagramCache.get(id) !== (data as any).dataUrl) {
				localDiagramCache.set(id, (data as any).dataUrl);
				updated = true;
			}
		}
		if (updated) {
			// Clear cache to force image src update
			activeCommentBoxes.forEach((box) => boxRenderCache.delete(box));
			renderCommentBoxes();
		}
	}
});

// Last innerHTML rendered into each box. renderCommentBoxes() runs on every
// highlight mutation, storage sync, scroll-driven reapply, etc. Rebuilding
// innerHTML every time wipes an open editor (losing in-progress text + focus)
// and — worse — detaches the Save/Cancel buttons. If an async rebuild lands
// between a button's mousedown and mouseup, the click resolves on the box div
// instead of the button and the action silently no-ops. Skipping the rebuild
// when the rendered content is unchanged keeps the editor DOM stable so typing
// and saving work reliably. Keyed by box element so entries GC with the box.
const boxRenderCache = new WeakMap<HTMLElement, string>();

const localDiagramCache = new Map<string, string>();

// --- Group handling ----------------------------------------------------------
// A multi-block selection (e.g. several bullet points) produces one highlight
// per block sharing a `groupId`. On the live page we treat the whole group as a
// SINGLE annotation: one comment thread, one box, anchored to the group's first
// piece (its "representative"). All comment ids passed around in this module are
// representative ids.

// Every highlight in the same annotation unit as `h`, in document order.
// `highlights` is kept sorted, so the first entry is the representative.
function groupMembers(h: AnyHighlightData): AnyHighlightData[] {
	if (!h.groupId) return [h];
	return highlights.filter(x => x.groupId === h.groupId);
}

// Map any piece id to its group's representative highlight.
function repFor(id: string): AnyHighlightData | undefined {
	const h = highlights.find(x => x.id === id);
	return h ? groupMembers(h)[0] : undefined;
}

// One flattened comment thread for the whole group. Each ref records which
// piece actually stores the note so edits/deletes target the right highlight.
interface NoteRef { note: string; ownerId: string; ownerIndex: number }
function groupNotes(rep: AnyHighlightData): NoteRef[] {
	const refs: NoteRef[] = [];
	for (const m of groupMembers(rep)) {
		(m.notes || []).forEach((note, ownerIndex) => refs.push({ note, ownerId: m.id, ownerIndex }));
	}
	return refs;
}

function parseNoteString(note: string): { text: string, timestamp?: number, edited?: number } {
	const tsMatch = note.match(/<!--timestamp:(\d+)-->/);
	const edMatch = note.match(/<!--edited:(\d+)-->/);
	const text = note
		.replace(/<!--timestamp:\d+-->/, '')
		.replace(/<!--edited:\d+-->/, '')
		.trim();
	return {
		text,
		// Creation time, also the stable per-comment id used by the sync merge.
		timestamp: tsMatch ? parseInt(tsMatch[1]) : undefined,
		// Last-edit time, written by saveEditedComment; used to resolve when the
		// same comment was edited on two devices.
		edited: edMatch ? parseInt(edMatch[1]) : undefined
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
	// Comment on the group as a whole, not the individual block that was clicked.
	const rep = repFor(highlightId);
	if (rep) highlightId = rep.id;
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

	// One box per annotation unit (a group → its representative; or an ungrouped
	// highlight). A unit gets a box if any of its pieces carries a comment or its
	// representative is currently being edited.
	const highlightsWithComments: AnyHighlightData[] = [];
	const seenUnits = new Set<string>();
	for (const h of highlights) {
		const key = h.groupId || h.id;
		if (seenUnits.has(key)) continue;
		seenUnits.add(key);
		const rep = groupMembers(h)[0];
		const hasComment = groupMembers(rep).some(m => m.notes && m.notes.length > 0);
		if (hasComment || editingHighlightIds.has(rep.id)) highlightsWithComments.push(rep);
	}

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
		// The textarea just grew to fit the note; re-run the layout so boxes below
		// reflow and don't overlap this one (autosize happens after the initial
		// render, so the first layout used the collapsed 1-row height).
		renderCommentBoxes();
	}, 0);
}

function createCommentBox(highlight: AnyHighlightData): HTMLElement {
	const box = document.createElement('div');
	box.className = 'obsidian-comment-box';
	box.dataset.highlightId = highlight.id;
	// Drives the box's permanent color-matched border (see highlighter.scss).
	box.dataset.color = highlight.color || 'yellow';
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
		} else if (target.closest('.obsidian-comment-save-new')) {
			const textarea = box.querySelector('textarea.new-comment-textarea') as HTMLTextAreaElement;
			if (textarea) {
				const text = textarea.value.trim();
				saveComment(highlight.id, text);
			}
		} else if (target.closest('.obsidian-comment-diagram-new')) {
			// Save a new empty diagram comment, then open the editor
			const diagramId = 'd' + Math.random().toString(36).substring(2, 9);
			saveComment(highlight.id, `<!--diagram:${diagramId}-->`);
			browser.runtime.sendMessage({ action: 'openPopupWithDiagram', id: diagramId });
		} else if (target.closest('.obsidian-comment-diagram-img')) {
			const img = target.closest('.obsidian-comment-diagram-img') as HTMLImageElement;
			const diagramId = img.dataset.diagramId;
			if (diagramId) {
				browser.runtime.sendMessage({ action: 'openPopupWithDiagram', id: diagramId });
			}
		} else if (target.closest('.obsidian-comment-text')) {
			const textEl = target.closest('.obsidian-comment-text') as HTMLElement;
			const noteIndex = textEl.dataset.index;
			const expandKey = `${highlight.id}-${noteIndex}`;
			if (singleClickTimer) clearTimeout(singleClickTimer);
			// Short delay disambiguates a single click (expand) from a double click
			// (edit). Re-query the live element when the timer fires so the overflow
			// check reads the current DOM rather than a possibly-stale reference.
			singleClickTimer = window.setTimeout(() => {
				singleClickTimer = null;
				if (expandedCommentIndexes.has(expandKey)) {
					expandedCommentIndexes.delete(expandKey);
				} else {
					const liveEl = box.querySelector(`.obsidian-comment-text[data-index="${noteIndex}"]`) as HTMLElement | null;
					const overflows = !!liveEl && (liveEl.classList.contains('has-overflow') || liveEl.scrollHeight > liveEl.clientHeight);
					if (overflows) expandedCommentIndexes.add(expandKey);
				}
				renderCommentBoxes();
			}, 250);
		}
	});

	box.addEventListener('mouseenter', () => setActiveHighlight(highlight.id));
	box.addEventListener('mouseleave', () => setActiveHighlight(null));

	box.addEventListener('dblclick', (e) => {
		const target = e.target as HTMLElement;
		const textEl = target.closest('.obsidian-comment-text') as HTMLElement;
		if (textEl) {
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

	// Keep the editor sized to its content as the user types, and glow the submit button.
	box.addEventListener('input', (e) => {
		const ta = e.target as HTMLElement;
		if (ta instanceof HTMLTextAreaElement &&
			(ta.classList.contains('edit-comment-textarea') || ta.classList.contains('new-comment-textarea'))) {
			autosizeTextarea(ta);

			const editorDiv = ta.closest('.obsidian-comment-editor');
			if (editorDiv) {
				if (ta.value.trim().length > 0) {
					editorDiv.classList.add('has-text');
				} else {
					editorDiv.classList.remove('has-text');
				}
			}
			// Reflow neighboring boxes as this one grows/shrinks while typing, so
			// they never overlap. The cache in updateCommentBox keeps the textarea
			// DOM (and the caret/text) intact across the re-layout.
			renderCommentBoxes();
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

		if (e.key === 'Enter' && !e.shiftKey) {
			if (e.isComposing) return;
			e.preventDefault();
			if (isNew) {
				saveComment(highlight.id, ta.value.trim());
			} else if (editingNoteKey) {
				const { highlightId, index } = parseNoteKey(editingNoteKey);
				saveEditedComment(highlightId, index, ta.value.trim());
			}
			return;
		}

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
	// `highlight` is the group representative; the thread aggregates every piece.
	const noteRefs = groupNotes(highlight);
	const notes = noteRefs.map(r => r.note);
	const isEditing = editingHighlightIds.has(highlight.id);
	const isFocused = focusedHighlightId === highlight.id || isEditing;

	// Focus state is reflected as a class (not baked into the HTML) so the box's
	// rendered markup is identical whether or not it's focused. That keeps the
	// DOM stable across a focus change, which is essential: rebuilding innerHTML
	// on focus used to detach the very element the user just clicked, swallowing
	// that click — so expanding a comment took two clicks (one to focus, one to
	// expand). With visibility driven by CSS, a single click both focuses and
	// expands. Applied before the cache short-circuit so focus always updates.
	box.classList.toggle('is-focused', isFocused);
	// No comments yet → collapse the outer card so the new-comment field is a
	// single slim box rather than a box-within-a-box.
	box.classList.toggle('is-empty', notes.length === 0);

	let html = '';

	// The comment editor / reply field. Always rendered (hidden via CSS unless
	// the box is focused) so toggling focus never rebuilds the DOM. It sits after
	// the comment list, so the reply field is always at the end of the thread.
	const editorHtml = `
		<div class="obsidian-comment-editor sleek-input">
			<textarea class="new-comment-textarea" placeholder="${notes.length > 0 ? 'Reply…' : 'Add a comment…'}" rows="1"></textarea>
			<div class="obsidian-comment-editor-actions">
				<button class="obsidian-comment-diagram-new" aria-label="Add Diagram" title="Add Diagram">
					<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v20"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
				</button>
				<button class="obsidian-comment-save-new" aria-label="Submit">
					<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>
				</button>
			</div>
		</div>
	`;

	if (notes.length > 0) {
		html += `<div class="obsidian-comment-list">`;
		notes.forEach((note, index) => {
			const isExpanded = expandedCommentIndexes.has(`${highlight.id}-${index}`);
			const isEditingThisNote = editingNoteKey === `${highlight.id}-${index}`;
			const parsed = parseNoteString(note);

			let displayHtml = '';
			const diagramMatch = parsed.text.match(/^<!--diagram:([A-Za-z0-9_-]+)-->$/);
			if (diagramMatch) {
				const diagramId = diagramMatch[1];
				const src = localDiagramCache.get(diagramId) || '';
				displayHtml = `<img class="obsidian-comment-diagram-img" data-diagram-id="${diagramId}" style="width: 100%; border-radius: 4px; cursor: pointer; display: block;" src="${src}" alt="Diagram"/>`;
				if (!src) {
					// Trigger fetch without waiting
					browser.storage.local.get('diagrams').then(res => {
						const diagrams = (res.diagrams || {}) as Record<string, any>;
						const d = diagrams[diagramId];
						if (d && d.dataUrl) {
							localDiagramCache.set(diagramId, d.dataUrl);
							boxRenderCache.delete(box);
							renderCommentBoxes();
						}
					});
				}
			} else {
				displayHtml = escapeHtml(parsed.text);
				displayHtml = renderInlineMarkdown(displayHtml);
				displayHtml = displayHtml.replace(/(^|\s)(#[a-zA-Z0-9_-]+)/g, '$1<span class="obsidian-inline-tag">$2</span>');
			}

			if (isEditingThisNote) {
				html += `
					<div class="obsidian-comment-item">
						<div class="obsidian-comment-editor sleek-input is-editing">
							<textarea class="edit-comment-textarea" rows="1">${escapeHtml(parsed.text)}</textarea>
							<div class="obsidian-comment-editor-actions">
								<button class="obsidian-comment-delete" data-index="${index}" aria-label="Delete">
									<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
								</button>
							</div>
						</div>
					</div>
				`;
			} else {
				// Threaded layout: a header line (colored dot on the thread rail +
				// timestamp + hover actions), with the comment text beneath it.
				html += `
					<div class="obsidian-comment-item">
						<div class="obsidian-comment-item-header">
							<span class="obsidian-comment-dot"></span>
							${parsed.timestamp ? `<span class="obsidian-comment-timestamp">${formatTime(parsed.timestamp)}</span>` : '<span class="obsidian-comment-timestamp"></span>'}
							<div class="obsidian-comment-actions-inline">
								<button class="obsidian-comment-edit" data-index="${index}" aria-label="Edit comment">
									<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
								</button>
								<button class="obsidian-comment-delete" data-index="${index}" aria-label="Delete comment">
									<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
								</button>
							</div>
						</div>
						<div class="obsidian-comment-text ${isExpanded ? '' : 'is-collapsed'}" data-index="${index}">${displayHtml}</div>
					</div>
				`;
			}
		});
		html += `</div>`;
	}

	html += editorHtml;

	// Only touch the DOM when the rendered content actually changed. An open
	// editor's textarea value (and the add-comment editor's emptiness) is not
	// Keep the color-matched border in sync if the highlight was recolored.
	box.dataset.color = highlight.color || 'yellow';

	// part of `html`, so skipping the rebuild preserves whatever the user has
	// typed and keeps the Save/Cancel buttons attached across re-renders.
	if (boxRenderCache.get(box) === html) return;
	boxRenderCache.set(box, html);
	box.innerHTML = html;
}

window.addEventListener('obsidian-add-comment', ((e: CustomEvent) => {
	startAddingComment(e.detail);
}) as EventListener);

// Commit every open editor — used when the user interacts outside the comment
// boxes. Reads each editor's current text and saves it (empty text just closes
// the editor, same as Cancel).
function commitOpenEditors() {
	if (focusedHighlightId) {
		const ta = activeCommentBoxes.get(focusedHighlightId)?.querySelector('textarea.new-comment-textarea') as HTMLTextAreaElement | null;
		if (ta && ta.value.trim()) {
			saveComment(focusedHighlightId, ta.value.trim());
		}
	}
	// Snapshot ids first: saveComment() mutates editingHighlightIds mid-loop.
	for (const id of Array.from(editingHighlightIds)) {
		const ta = activeCommentBoxes.get(id)?.querySelector('textarea.new-comment-textarea') as HTMLTextAreaElement | null;
		if (ta && ta.value.trim()) {
			saveComment(id, ta.value.trim());
		}
	}
	if (editingNoteKey) {
		const { highlightId, index } = parseNoteKey(editingNoteKey);
		const ta = activeCommentBoxes.get(highlightId)?.querySelector('textarea.edit-comment-textarea') as HTMLTextAreaElement | null;
		if (ta) {
			saveEditedComment(highlightId, index, ta.value.trim());
		} else {
			editingNoteKey = null;
			renderCommentBoxes();
		}
	}
}

document.addEventListener('mousedown', (e) => {
	const target = e.target as HTMLElement | null;
	const box = target?.closest('.obsidian-comment-box') as HTMLElement | null;

	if (!box) {
		let changed = false;
		if (editingHighlightIds.size > 0 || editingNoteKey || focusedHighlightId) {
			commitOpenEditors();
			changed = true;
		}
		if (focusedHighlightId) {
			focusedHighlightId = null;
			changed = true;
		}
		if (expandedCommentIndexes.size > 0) {
			expandedCommentIndexes.clear();
			changed = true;
		}
		if (changed) renderCommentBoxes();
		return;
	}

	const highlightId = Array.from(activeCommentBoxes.entries()).find(([_, b]) => b === box)?.[0];
	if (highlightId && focusedHighlightId !== highlightId) {
		if (editingHighlightIds.size > 0 || editingNoteKey || focusedHighlightId) {
			commitOpenEditors();
		}
		focusedHighlightId = highlightId;
		renderCommentBoxes();
	}
}, true);

function saveComment(highlightId: string, text: string) {
	if (!text) {
		stopAddingComment(highlightId);
		if (focusedHighlightId === highlightId) {
			focusedHighlightId = null;
			renderCommentBoxes();
		}
		return;
	}
	
	const formattedText = `${text}<!--timestamp:${Date.now()}-->`;

	const highlight = highlights.find(h => h.id === highlightId);
	if (highlight) {
		// Build a NEW highlight object (don't mutate in place) so updateHighlights'
		// pre-change snapshot keeps the old notes — that's what makes Ctrl+Z able to
		// remove a just-added comment.
		const newNotes = [...(highlight.notes || []), formattedText];
		expandedCommentIndexes.delete(`${highlightId}-${newNotes.length - 1}`);
		const updated = { ...highlight, notes: newNotes };
		const newHighlights = highlights.map(h => h.id === highlightId ? updated : h);
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

	// `index` is into the group's flattened thread; resolve the piece that owns it.
	const rep = highlights.find(h => h.id === highlightId);
	const ref = rep ? groupNotes(rep)[index] : undefined;
	const owner = ref ? highlights.find(h => h.id === ref.ownerId) : undefined;
	if (owner && owner.notes && ref) {
		const oldParsed = parseNoteString(owner.notes[ref.ownerIndex]);
		const ts = oldParsed.timestamp || Date.now();
		// Keep the original creation timestamp (the comment's stable id) but record
		// a fresh edit time so cross-device merges keep the most recent edit.
		// Build new objects so the undo snapshot retains the pre-edit text.
		const newNotes = owner.notes.map((n, i) =>
			i === ref.ownerIndex ? `${text}<!--timestamp:${ts}--><!--edited:${Date.now()}-->` : n);
		expandedCommentIndexes.delete(`${highlightId}-${index}`);
		const updated = { ...owner, notes: newNotes };
		const newHighlights = highlights.map(h => h.id === owner.id ? updated : h);
		updateHighlights(newHighlights);
		saveHighlights();
		renderCommentBoxes();
	}
}

function deleteComment(highlightId: string, index: number) {
	// `index` is into the group's flattened thread; resolve the owning piece.
	const rep = highlights.find(h => h.id === highlightId);
	const ref = rep ? groupNotes(rep)[index] : undefined;
	const owner = ref ? highlights.find(h => h.id === ref.ownerId) : undefined;
	if (owner && owner.notes && ref) {
		// New objects (no in-place splice) so undo can restore the deleted comment.
		const newNotes = owner.notes.filter((_, i) => i !== ref.ownerIndex);
		const updated = { ...owner, notes: newNotes };
		const newHighlights = highlights.map(h => h.id === owner.id ? updated : h);
		updateHighlights(newHighlights);
		saveHighlights();
		setActiveHighlight(null); // clear emphasis in case the box is removed
		renderCommentBoxes();
	}
}

export function clearCommentBoxes() {
	activeCommentBoxes.forEach(box => box.remove());
	activeCommentBoxes.clear();
	document.body.style.paddingRight = '';
	document.body.style.paddingLeft = '';
	setActiveHighlight(null);
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

function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}
