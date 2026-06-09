import { AnyHighlightData, highlights, saveHighlights, updateHighlights } from './highlighter';
import { getElementByXPath } from './dom-utils';
import { textHighlightRanges } from './highlighter-overlays';

const COMMENT_BOX_WIDTH = 280;
const COMMENT_BOX_MARGIN = 20;
const COMMENT_BOX_GAP = 12;

let activeCommentBoxes = new Map<string, HTMLElement>();
let editingHighlightIds = new Set<string>();
let expandedCommentIndexes = new Set<string>(); // highlightId-index

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
	const box = activeCommentBoxes.get(highlightId);
	if (box) {
		const textarea = box.querySelector('textarea');
		if (textarea) {
			textarea.focus();
		}
	}
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
			const textarea = box.querySelector('textarea') as HTMLTextAreaElement;
			if (textarea) {
				const text = textarea.value.trim();
				saveComment(highlight.id, text);
			}
		} else if (target.closest('.obsidian-comment-cancel')) {
			stopAddingComment(highlight.id);
		} else if (target.closest('.obsidian-comment-delete')) {
			const noteIndex = parseInt((target.closest('.obsidian-comment-delete') as HTMLElement).dataset.index || '0');
			deleteComment(highlight.id, noteIndex);
		} else if (target.closest('.obsidian-comment-text')) {
			const textEl = target.closest('.obsidian-comment-text') as HTMLElement;
			const noteIndex = textEl.dataset.index;
			const expandKey = `${highlight.id}-${noteIndex}`;
			if (expandedCommentIndexes.has(expandKey)) {
				expandedCommentIndexes.delete(expandKey);
			} else if (textEl.classList.contains('has-overflow')) {
				// Only expand if it actually overflows
				expandedCommentIndexes.add(expandKey);
			}
			renderCommentBoxes();
		}
	});

	box.addEventListener('mouseenter', () => showActiveRing(highlight.id));
	box.addEventListener('mouseleave', () => hideActiveRing());

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
			html += `
				<div class="obsidian-comment-item">
					<div class="obsidian-comment-text ${isExpanded ? '' : 'is-collapsed'}" data-index="${index}">${escapeHtml(note)}</div>
					<button class="obsidian-comment-delete" data-index="${index}" aria-label="Delete comment">
						<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
					</button>
				</div>
			`;
		});
		html += `</div>`;
	}

	if (isEditing) {
		html += `
			<div class="obsidian-comment-editor">
				<textarea placeholder="Add a comment..." rows="3"></textarea>
				<div class="obsidian-comment-actions">
					<button class="obsidian-comment-cancel">Cancel</button>
					<button class="obsidian-comment-save mod-cta">Save</button>
				</div>
			</div>
		`;
	} else {
		html += `
			<button class="obsidian-comment-add-more" onclick="window.dispatchEvent(new CustomEvent('obsidian-add-comment', {detail: '${highlight.id}'}))">
				Add reply...
			</button>
		`;
	}

	box.innerHTML = html;
}

window.addEventListener('obsidian-add-comment', ((e: CustomEvent) => {
	startAddingComment(e.detail);
}) as EventListener);

function saveComment(highlightId: string, text: string) {
	if (!text) {
		stopAddingComment(highlightId);
		return;
	}
	
	const highlight = highlights.find(h => h.id === highlightId);
	if (highlight) {
		if (!highlight.notes) highlight.notes = [];
		highlight.notes.push(text);
		// Update global highlights array
		const newHighlights = highlights.map(h => h.id === highlightId ? highlight : h);
		updateHighlights(newHighlights);
		saveHighlights();
	}
	stopAddingComment(highlightId);
}

function deleteComment(highlightId: string, index: number) {
	const highlight = highlights.find(h => h.id === highlightId);
	if (highlight && highlight.notes) {
		highlight.notes.splice(index, 1);
		const newHighlights = highlights.map(h => h.id === highlightId ? highlight : h);
		updateHighlights(newHighlights);
		saveHighlights();
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
