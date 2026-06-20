/**
 * Annotation data model + persistence for the Clipper Annotations plugin.
 *
 * Annotations are keyed by the **normalized source URL** of the clipped note
 * (read from the note's `source` frontmatter), exactly like the browser
 * extension keys its `highlights` store. That shared key + the shared
 * {@link AnnotationAnchor} are what let an annotation made here round-trip back
 * to the live web page later (see the bidirectional-sync task).
 *
 * For now the store persists to the plugin's own `data.json` via
 * `Plugin.saveData`. Swapping this for the shared Drive `clipper-sync.json`
 * client is a later, isolated step — callers only depend on the methods below.
 */

import type { AnnotationAnchor, AnchorSurface } from '../../shared/anchor';
// The URL key MUST be computed identically to the extension, or annotations
// won't match the note. Use the one shared implementation — never re-derive it.
import { normalizeUrl } from '../../shared/url';

export { normalizeUrl };

export type HighlightColor = 'yellow' | 'red' | 'green';

/** One chat-style comment. `id` is a creation timestamp string for sync-merge parity. */
export interface CommentMsg {
	id: string;
	text: string;
	createdAt: number;
	editedAt?: number;
}

export interface Annotation {
	id: string;
	color: HighlightColor;
	anchor: AnnotationAnchor;
	comments: CommentMsg[];
	createdAt: number;
	updatedAt: number;
	/** Surface the annotation was first created on. */
	origin: AnchorSurface;
	/** 'image' for image/element annotations (anchored by image src); else text. */
	kind?: 'text' | 'image';
	/** The extension highlight.type this maps to ('element' for images) — kept for round-trip. */
	htype?: 'text' | 'element';
	/** Original element outerHTML (image highlights) — kept so the extension can re-render it. */
	content?: string;
}

export interface SourceAnnotations {
	url: string;
	title?: string;
	annotations: Annotation[];
}

export interface StoreData {
	version: 1;
	bySource: Record<string, SourceAnnotations>;
}

const EMPTY: StoreData = { version: 1, bySource: {} };

type Persist = (data: StoreData) => Promise<void>;

/** Generate a timestamp-ordered id; monotonic within a session. */
let lastStamp = 0;
export function newId(prefix: string, now: number): string {
	let t = now;
	if (t <= lastStamp) t = lastStamp + 1;
	lastStamp = t;
	return `${prefix}-${t}`;
}

export class AnnotationStore {
	private data: StoreData;
	private persist: Persist;
	private listeners = new Set<(url: string) => void>();

	constructor(loaded: Partial<StoreData> | null, persist: Persist) {
		this.data = loaded && loaded.version === 1 ? (loaded as StoreData) : { ...EMPTY };
		if (!this.data.bySource) this.data.bySource = {};
		this.persist = persist;
	}

	/** Subscribe to changes for a source; returns an unsubscribe fn. */
	onChange(fn: (url: string) => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private emit(url: string): void {
		for (const fn of this.listeners) fn(url);
	}

	private async save(url: string): Promise<void> {
		await this.persist(this.data);
		this.emit(url);
	}

	for(url: string): Annotation[] {
		const key = normalizeUrl(url);
		return this.data.bySource[key]?.annotations ?? [];
	}

	get(url: string, id: string): Annotation | undefined {
		return this.for(url).find((a) => a.id === id);
	}

	private bucket(url: string, title?: string): SourceAnnotations {
		const key = normalizeUrl(url);
		let b = this.data.bySource[key];
		if (!b) {
			b = { url: key, title, annotations: [] };
			this.data.bySource[key] = b;
		} else if (title && !b.title) {
			b.title = title;
		}
		return b;
	}

	async addHighlight(
		url: string,
		anchor: AnnotationAnchor,
		color: HighlightColor,
		now: number,
		title?: string,
	): Promise<Annotation> {
		const b = this.bucket(url, title);
		const ann: Annotation = {
			id: newId('hl', now),
			color,
			anchor,
			comments: [],
			createdAt: now,
			updatedAt: now,
			origin: 'obsidian',
		};
		b.annotations.push(ann);
		await this.save(url);
		return ann;
	}

	async addImageHighlight(
		url: string,
		anchor: AnnotationAnchor,
		color: HighlightColor,
		now: number,
		title?: string,
	): Promise<Annotation> {
		const b = this.bucket(url, title);
		const img = anchor.image;
		const content = img
			? `<img src="${img.src}"${img.alt ? ` alt="${img.alt}"` : ''}>`
			: '';
		const ann: Annotation = {
			id: newId('hl', now),
			color,
			anchor,
			comments: [],
			createdAt: now,
			updatedAt: now,
			origin: 'obsidian',
			kind: 'image',
			htype: 'element',
			content,
		};
		b.annotations.push(ann);
		await this.save(url);
		return ann;
	}

	async setColor(url: string, id: string, color: HighlightColor, now: number): Promise<void> {
		const ann = this.get(url, id);
		if (!ann || ann.color === color) return;
		ann.color = color;
		ann.updatedAt = now;
		await this.save(url);
	}

	async addComment(url: string, id: string, text: string, now: number): Promise<CommentMsg | undefined> {
		const ann = this.get(url, id);
		if (!ann) return;
		const msg: CommentMsg = { id: newId('c', now), text, createdAt: now };
		ann.comments.push(msg);
		ann.updatedAt = now;
		await this.save(url);
		return msg;
	}

	async editComment(url: string, id: string, commentId: string, text: string, now: number): Promise<void> {
		const ann = this.get(url, id);
		const msg = ann?.comments.find((c) => c.id === commentId);
		if (!ann || !msg) return;
		msg.text = text;
		msg.editedAt = now;
		ann.updatedAt = now;
		await this.save(url);
	}

	async deleteComment(url: string, id: string, commentId: string, now: number): Promise<void> {
		const ann = this.get(url, id);
		if (!ann) return;
		ann.comments = ann.comments.filter((c) => c.id !== commentId);
		ann.updatedAt = now;
		await this.save(url);
	}

	async deleteAnnotation(url: string, id: string): Promise<void> {
		const key = normalizeUrl(url);
		const b = this.data.bySource[key];
		if (!b) return;
		b.annotations = b.annotations.filter((a) => a.id !== id);
		await this.save(url);
	}

	// --- sync bridge ------------------------------------------------------

	/** The raw store blob, for the plugin's unified persistence. */
	raw(): StoreData {
		return this.data;
	}

	/** Every source bucket (deep-cloned) — the local state to reconcile against Drive. */
	allSources(): SourceAnnotations[] {
		return JSON.parse(JSON.stringify(Object.values(this.data.bySource)));
	}

	/** Replace the entire store with merged sync results, then persist + notify. */
	async replaceAll(sources: SourceAnnotations[]): Promise<void> {
		this.data.bySource = {};
		for (const s of sources) {
			if (s.annotations.length) this.data.bySource[normalizeUrl(s.url)] = s;
		}
		await this.persist(this.data);
		for (const url of Object.keys(this.data.bySource)) this.emit(url);
	}
}
