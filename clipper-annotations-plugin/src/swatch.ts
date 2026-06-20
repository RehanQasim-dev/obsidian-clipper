/**
 * Floating color-swatch popup, shown above a text selection in reading view —
 * the same interaction the browser extension uses on live pages: three circular
 * color swatches (yellow / red / green) plus a Comment action.
 *
 * In-context keyboard parity while the popup is visible:
 *   1 / 2 / 3 → yellow / red / green   ·   c → comment   ·   Esc → dismiss
 *
 * The popup element is tagged `data-annot-ui` so the shared anchor's text walker
 * never treats it as document content.
 */

import type { HighlightColor } from './store';

export interface SwatchActions {
	onColor: (color: HighlightColor) => void;
	onComment: () => void;
}

const ORDER: HighlightColor[] = ['yellow', 'red', 'green'];

export class SwatchPopup {
	private el: HTMLElement;
	private doc: Document;
	private actions: SwatchActions;
	private shown = false;
	private keyHandler: (e: KeyboardEvent) => void;

	constructor(doc: Document, actions: SwatchActions) {
		this.doc = doc;
		this.actions = actions;
		this.el = this.build();
		this.keyHandler = (e) => this.onKey(e);
	}

	get visible(): boolean {
		return this.shown;
	}

	private build(): HTMLElement {
		const root = this.doc.createElement('div');
		root.className = 'oc-swatch';
		root.setAttribute('data-annot-ui', '');
		root.style.display = 'none';

		for (const color of ORDER) {
			const dot = this.doc.createElement('button');
			dot.className = `oc-swatch-dot oc-swatch-${color}`;
			dot.setAttribute('aria-label', `Highlight ${color}`);
			dot.addEventListener('mousedown', (e) => e.preventDefault());
			dot.addEventListener('click', (e) => {
				e.preventDefault();
				e.stopPropagation();
				this.actions.onColor(color);
			});
			root.appendChild(dot);
		}

		const sep = this.doc.createElement('span');
		sep.className = 'oc-swatch-sep';
		root.appendChild(sep);

		const comment = this.doc.createElement('button');
		comment.className = 'oc-swatch-comment';
		comment.textContent = 'Comment';
		comment.addEventListener('mousedown', (e) => e.preventDefault());
		comment.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.actions.onComment();
		});
		root.appendChild(comment);

		this.doc.body.appendChild(root);
		return root;
	}

	/** Position the popup centered above `rect` (viewport coordinates). */
	showFor(rect: DOMRect): void {
		const el = this.el;
		el.style.display = 'flex';
		el.style.visibility = 'hidden';
		// Measure, then place.
		const w = el.offsetWidth;
		const h = el.offsetHeight;
		const margin = 8;
		let left = rect.left + rect.width / 2 - w / 2;
		let top = rect.top - h - margin;
		// Clamp into the viewport; flip below if no room above.
		left = Math.max(margin, Math.min(left, this.doc.documentElement.clientWidth - w - margin));
		if (top < margin) top = rect.bottom + margin;
		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(top)}px`;
		el.style.visibility = 'visible';
		if (!this.shown) {
			this.shown = true;
			this.doc.addEventListener('keydown', this.keyHandler, true);
		}
	}

	hide(): void {
		if (!this.shown) return;
		this.shown = false;
		this.el.style.display = 'none';
		this.doc.removeEventListener('keydown', this.keyHandler, true);
	}

	private onKey(e: KeyboardEvent): void {
		if (!this.shown) return;
		switch (e.key) {
			case '1':
				e.preventDefault();
				this.actions.onColor('yellow');
				break;
			case '2':
				e.preventDefault();
				this.actions.onColor('red');
				break;
			case '3':
				e.preventDefault();
				this.actions.onColor('green');
				break;
			case 'c':
			case 'C':
				e.preventDefault();
				this.actions.onComment();
				break;
			case 'Escape':
				e.preventDefault();
				this.hide();
				break;
		}
	}

	destroy(): void {
		this.hide();
		this.el.remove();
	}
}
