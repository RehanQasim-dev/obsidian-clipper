/**
 * The docked Comments panel.
 *
 * One **card per annotation** — a colored quote header (the highlighted text) +
 * its thread of comments + a reply box — so each conversation reads as a
 * visually separate unit. Hovering a card emphasizes its highlight in the
 * reading pane and vice-versa; the active card expands with its reply box
 * focused. Annotations whose text no longer resolves in the note are listed
 * under a clearly-labeled "Unplaced" group rather than disappearing.
 */

import { ItemView, MarkdownRenderer, WorkspaceLeaf, setIcon } from 'obsidian';
import type { Annotation, HighlightColor } from './store';

export const COMMENTS_VIEW_TYPE = 'clipper-comments';

export interface CommentsContext {
	url: string;
	title?: string;
	annotations: Annotation[];
	unplaced: Annotation[];
}

export interface CommentsController {
	getContext(): CommentsContext | null;
	addComment(id: string, text: string): Promise<void>;
	setColor(id: string, color: HighlightColor): Promise<void>;
	deleteAnnotation(id: string): Promise<void>;
	/** Emphasize (or clear) the matching highlight in the reading pane. */
	emphasizeInSource(id: string | null): void;
	/** Scroll the reading pane to the matching highlight. */
	revealInSource(id: string): void;
}

const COLORS: HighlightColor[] = ['yellow', 'red', 'green'];

export class CommentsView extends ItemView {
	private controller: CommentsController;
	private activeId: string | null = null;

	constructor(leaf: WorkspaceLeaf, controller: CommentsController) {
		super(leaf);
		this.controller = controller;
	}

	getViewType(): string {
		return COMMENTS_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Clipper comments';
	}

	getIcon(): string {
		return 'message-square';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('oc-comments');
		this.refresh();
	}

	/** Set the focused annotation and re-render. */
	focusAnnotation(id: string | null): void {
		this.activeId = id;
		this.refresh();
		if (id) {
			const input = this.contentEl.querySelector<HTMLTextAreaElement>(
				`.oc-card[data-ann-id="${cssEscape(id)}"] .oc-reply-input`,
			);
			input?.focus();
		}
	}

	/** Highlight the matching card without changing focus (hover from source). */
	setActive(id: string | null): void {
		this.contentEl.querySelectorAll('.oc-card.is-hover').forEach((el) => el.removeClass('is-hover'));
		if (!id) return;
		const card = this.contentEl.querySelector(`.oc-card[data-ann-id="${cssEscape(id)}"]`);
		card?.addClass('is-hover');
		card?.scrollIntoView({ block: 'nearest' });
	}

	refresh(): void {
		const root = this.contentEl;

		// A repaint can be triggered while the user is typing in a reply box (e.g.
		// focusing this panel fires Obsidian's active-leaf-change). Rebuilding the
		// DOM would destroy that textarea — stealing focus and any half-typed text.
		// Capture the focused reply box so we can restore it after the rebuild.
		const focused = this.captureFocusedReply();

		root.empty();

		const ctx = this.controller.getContext();
		if (!ctx) {
			root.createDiv({ cls: 'oc-empty', text: 'Open a clipped source note to see its annotations.' });
			return;
		}

		const header = root.createDiv({ cls: 'oc-panel-header' });
		header.createSpan({ cls: 'oc-panel-title', text: ctx.title || 'Annotations' });
		const count = ctx.annotations.length;
		header.createSpan({ cls: 'oc-panel-count', text: `${count} highlight${count === 1 ? '' : 's'}` });

		if (!ctx.annotations.length && !ctx.unplaced.length) {
			root.createDiv({ cls: 'oc-empty', text: 'Select text in the note to highlight and comment.' });
			return;
		}

		const list = root.createDiv({ cls: 'oc-card-list' });
		for (const ann of ctx.annotations) this.renderCard(list, ann, false);

		if (ctx.unplaced.length) {
			const group = root.createDiv({ cls: 'oc-unplaced' });
			const gh = group.createDiv({ cls: 'oc-unplaced-header' });
			setIcon(gh.createSpan({ cls: 'oc-unplaced-icon' }), 'unlink');
			gh.createSpan({ text: `Unplaced (${ctx.unplaced.length})` });
			gh.setAttr('title', "These annotations' text was not found in the current note.");
			for (const ann of ctx.unplaced) this.renderCard(group, ann, true);
		}

		this.restoreFocusedReply(focused);
	}

	/** Snapshot the reply box that currently has focus (if any), so refresh can restore it. */
	private captureFocusedReply(): { annId: string; value: string; start: number; end: number } | null {
		const active = this.contentEl.ownerDocument.activeElement;
		if (!(active instanceof HTMLTextAreaElement) || !active.hasClass('oc-reply-input')) return null;
		if (!this.contentEl.contains(active)) return null;
		const card = active.closest<HTMLElement>('.oc-card');
		const annId = card?.dataset.annId;
		if (!annId) return null;
		return { annId, value: active.value, start: active.selectionStart ?? 0, end: active.selectionEnd ?? 0 };
	}

	/** Re-focus the reply box captured before a rebuild, restoring its text + caret. */
	private restoreFocusedReply(snap: { annId: string; value: string; start: number; end: number } | null): void {
		if (!snap) return;
		const input = this.contentEl.querySelector<HTMLTextAreaElement>(
			`.oc-card[data-ann-id="${cssEscape(snap.annId)}"] .oc-reply-input`,
		);
		if (!input) return;
		input.value = snap.value;
		autoGrow(input);
		input.focus();
		input.setSelectionRange(snap.start, snap.end);
	}

	private renderCard(parent: HTMLElement, ann: Annotation, unplaced: boolean): void {
		const card = parent.createDiv({ cls: `oc-card oc-color-${ann.color}` });
		card.dataset.annId = ann.id;
		if (ann.id === this.activeId) card.addClass('is-active');
		if (unplaced) card.addClass('is-unplaced');

		if (!unplaced) {
			card.addEventListener('mouseenter', () => this.controller.emphasizeInSource(ann.id));
			card.addEventListener('mouseleave', () => this.controller.emphasizeInSource(null));
		}

		// Header: an image preview for image annotations, else the quoted text.
		const head = card.createDiv({ cls: 'oc-card-head' });
		const image = ann.anchor.image;
		if (image?.src) {
			card.addClass('oc-card-image');
			const fig = head.createDiv({ cls: 'oc-quote oc-quote-image' });
			const thumb = fig.createEl('img', { cls: 'oc-thumb' });
			thumb.referrerPolicy = 'no-referrer'; // many hosts 403 hotlinks with a referer
			thumb.src = image.src;
			if (image.alt) thumb.alt = image.alt;
			thumb.loading = 'lazy';
			thumb.addEventListener('error', () => {
				fig.addClass('oc-thumb-failed');
				fig.setAttr('title', image.src);
			});
		} else {
			head.createDiv({ cls: 'oc-quote', text: ann.anchor.quote.quote });
		}

		const tools = head.createDiv({ cls: 'oc-card-tools' });
		for (const color of COLORS) {
			const dot = tools.createEl('button', { cls: `oc-mini-dot oc-swatch-${color}` });
			if (color === ann.color) dot.addClass('is-current');
			dot.setAttr('aria-label', `Recolor ${color}`);
			dot.addEventListener('click', (e) => {
				e.stopPropagation();
				void this.controller.setColor(ann.id, color);
			});
		}
		const del = tools.createEl('button', { cls: 'oc-mini-btn' });
		setIcon(del, 'trash-2');
		del.setAttr('aria-label', 'Delete highlight');
		del.addEventListener('click', (e) => {
			e.stopPropagation();
			void this.controller.deleteAnnotation(ann.id);
		});

		if (!unplaced) {
			head.addEventListener('click', () => {
				this.controller.revealInSource(ann.id);
				this.focusAnnotation(ann.id);
			});
		}

		// Thread.
		const thread = card.createDiv({ cls: 'oc-thread' });
		if (!ann.comments.length) {
			thread.createDiv({ cls: 'oc-no-comments', text: 'No comments yet' });
		}
		for (const msg of ann.comments) {
			const bubble = thread.createDiv({ cls: 'oc-msg' });
			const body = bubble.createDiv({ cls: 'oc-msg-body' });
			void MarkdownRenderer.render(this.app, msg.text, body, '', this);
			const meta = bubble.createDiv({ cls: 'oc-msg-meta' });
			meta.setText(formatTime(msg.createdAt) + (msg.editedAt ? ' · edited' : ''));
		}

		// Reply box.
		const reply = card.createDiv({ cls: 'oc-reply' });
		const input = reply.createEl('textarea', { cls: 'oc-reply-input' });
		input.placeholder = 'Write a comment…';
		input.rows = 1;
		input.addEventListener('input', () => autoGrow(input));
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				if (e.isComposing) return;
				e.preventDefault();
				this.submit(ann.id, input);
			}
		});
		const send = reply.createEl('button', { cls: 'oc-reply-send', text: 'Send' });
		send.addEventListener('click', () => this.submit(ann.id, input));
	}

	private submit(id: string, input: HTMLTextAreaElement): void {
		const text = input.value.trim();
		if (!text) return;
		input.value = '';
		autoGrow(input);
		void this.controller.addComment(id, text);
	}
}

function autoGrow(el: HTMLTextAreaElement): void {
	el.style.height = 'auto';
	el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
}

function formatTime(ts: number): string {
	try {
		return new Date(ts).toLocaleString(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
		});
	} catch {
		return '';
	}
}

function cssEscape(value: string): string {
	return value.replace(/["\\]/g, '\\$&');
}
