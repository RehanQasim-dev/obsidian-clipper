/**
 * Plugin ⇆ Drive reconcile.
 *
 * Maps the plugin's {@link Annotation}s to the canonical `clipper-sync.json`
 * highlight shape, runs the shared 3-way merge (so comments made here flow to the
 * extension and live pages, and vice-versa), and writes the result back.
 *
 * Data-loss guards:
 *  - The plugin only understands *highlights*. It passes the extension's
 *    `drawings` / `videoAnnotations` (and their tombstones) through untouched.
 *  - Highlights it can't render (no usable anchor) are preserved verbatim in a
 *    `foreign` bucket and fed back into every merge, so they're never seen as
 *    "deleted locally".
 */

import {
	mergeHighlightsStorage,
	type SyncFile,
	type HighlightsStorage,
	type StoredHighlights,
	type Highlight,
	type Tombstones,
} from '../../shared/merge';
import type { AnnotationAnchor } from '../../shared/anchor';
import type { Annotation, CommentMsg, HighlightColor, SourceAnnotations } from './store';
import { normalizeUrl } from './store';

// --- comment <-> note string encoding (matches the extension's note format) ---

function encodeComment(c: CommentMsg): string {
	return `${c.text}<!--timestamp:${c.createdAt}-->` + (c.editedAt ? `<!--edited:${c.editedAt}-->` : '');
}

function decodeComment(note: string): CommentMsg {
	const tsM = note.match(/<!--timestamp:(\d+)-->/);
	const edM = note.match(/<!--edited:(\d+)-->/);
	const createdAt = tsM?.[1] ? parseInt(tsM[1], 10) : Date.now();
	const text = note.replace(/<!--(?:timestamp|edited):\d+-->/g, '').trim();
	return {
		id: `c-${createdAt}`,
		text,
		createdAt,
		...(edM?.[1] ? { editedAt: parseInt(edM[1], 10) } : {}),
	};
}

// --- annotation <-> highlight mapping ----------------------------------------

// Pull an image src + alt out of an element highlight's stored outerHTML, so an
// image highlight made in the extension (which may predate the image anchor) can
// still be rendered + matched by source on the Obsidian side.
function imageFromContent(content: string | undefined): { src: string; alt?: string } | undefined {
	if (!content || !/<img[\s>]/i.test(content)) return undefined;
	const srcM =
		content.match(/<img[^>]*\ssrc=["']([^"']+)["']/i) ||
		content.match(/<img[^>]*\sdata-src=["']([^"']+)["']/i) ||
		content.match(/<img[^>]*\ssrcset=["']([^"',\s]+)/i);
	if (!srcM?.[1]) return undefined;
	const altM = content.match(/<img[^>]*\salt=["']([^"']*)["']/i);
	return { src: srcM[1].trim(), ...(altM?.[1] ? { alt: altM[1] } : {}) };
}

function annotationToHighlight(a: Annotation): Highlight {
	if (a.kind === 'image' || a.htype === 'element') {
		return {
			id: a.id,
			type: 'element',
			color: a.color,
			updatedAt: a.updatedAt,
			content: a.content ?? '',
			xpath: a.anchor.structural?.xpath ?? '',
			anchor: a.anchor,
			notes: a.comments.map(encodeComment),
		};
	}
	return {
		id: a.id,
		type: 'text',
		color: a.color,
		updatedAt: a.updatedAt,
		content: a.anchor.quote.quote,
		xpath: a.anchor.structural?.xpath ?? '',
		anchor: a.anchor,
		notes: a.comments.map(encodeComment),
	};
}

/** Resolve a possibly-relative image src against the note's source URL so it loads in the panel. */
function absolutize(src: string, baseUrl?: string): string {
	if (!src) return src;
	try {
		return baseUrl ? new URL(src, baseUrl).href : new URL(src).href;
	} catch {
		return src;
	}
}

function highlightToAnnotation(h: Highlight, baseUrl?: string): Annotation | null {
	let anchor = h.anchor as AnnotationAnchor | undefined;
	const content = typeof h.content === 'string' ? h.content : undefined;

	// Image/element highlight: anchored by image source, not text.
	const isElement = h.type === 'element';
	const img = anchor?.image ?? imageFromContent(content);
	if (isElement || img) {
		if (!img) return null; // an element highlight we can't render as an image — preserve verbatim
		img.src = absolutize(img.src, baseUrl);
		if (!anchor) anchor = { quote: { quote: '', prefix: '', suffix: '', occurrence: 0 } };
		anchor.image = img;
		const comments = (h.notes ?? []).map(decodeComment);
		const createdAt = parseInt(h.id, 10) || comments[0]?.createdAt || h.updatedAt || Date.now();
		return {
			id: h.id,
			color: (h.color as HighlightColor) || 'yellow',
			anchor,
			comments,
			createdAt,
			updatedAt: h.updatedAt ?? createdAt,
			origin: anchor.structural?.surface ?? 'web',
			kind: 'image',
			htype: 'element',
			content: content ?? `<img src="${img.src}"${img.alt ? ` alt="${img.alt}"` : ''}>`,
		};
	}

	if (!anchor || !anchor.quote?.quote) return null; // can't render without a text-quote
	const comments = (h.notes ?? []).map(decodeComment);
	const createdAt = parseInt(h.id, 10) || comments[0]?.createdAt || h.updatedAt || Date.now();
	return {
		id: h.id,
		color: (h.color as HighlightColor) || 'yellow',
		anchor,
		comments,
		createdAt,
		updatedAt: h.updatedAt ?? createdAt,
		origin: anchor.structural?.surface ?? 'web',
	};
}

/** Build the local highlights storage: foreign (verbatim) overlaid with our annotations. */
function toLocalHighlights(sources: SourceAnnotations[], foreign: HighlightsStorage): HighlightsStorage {
	const out: HighlightsStorage = JSON.parse(JSON.stringify(foreign));
	for (const s of sources) {
		const url = normalizeUrl(s.url);
		const bucket: StoredHighlights = out[url] ?? { url, title: s.title, highlights: [] };
		// Drop any prior copies of these ids (the annotation is authoritative for them).
		const ours = new Set(s.annotations.map((a) => a.id));
		bucket.highlights = bucket.highlights.filter((h) => !ours.has(h.id));
		for (const a of s.annotations) bucket.highlights.push(annotationToHighlight(a));
		if (s.title) bucket.title = s.title;
		out[url] = bucket;
	}
	return out;
}

/** Split merged highlights into renderable annotations + the preserved foreign bucket. */
function fromMergedHighlights(hs: HighlightsStorage): { sources: SourceAnnotations[]; foreign: HighlightsStorage } {
	const sources: SourceAnnotations[] = [];
	const foreign: HighlightsStorage = {};
	for (const url of Object.keys(hs)) {
		const entry = hs[url];
		if (!entry) continue;
		const annotations: Annotation[] = [];
		const foreignHl: Highlight[] = [];
		for (const h of entry.highlights) {
			const ann = highlightToAnnotation(h, url);
			if (ann) annotations.push(ann);
			else foreignHl.push(h);
		}
		if (annotations.length) sources.push({ url, title: entry.title, annotations });
		if (foreignHl.length) foreign[url] = { url, title: entry.title, highlights: foreignHl };
	}
	return { sources, foreign };
}

export interface ReconcileInput {
	snapshot: SyncFile; // base (last reconciled)
	remote: SyncFile; // current Drive state
	sources: SourceAnnotations[]; // this device's annotations
	foreign: HighlightsStorage; // highlights we couldn't render, preserved
	now: number;
}

export interface ReconcileOutput {
	merged: SyncFile; // to upload + store as the new snapshot
	sources: SourceAnnotations[]; // to write into the annotation store
	foreign: HighlightsStorage; // to persist for next time
}

/**
 * Pure reconcile: merge only the `highlights` slice; pass the extension's
 * drawings/video and their tombstones through verbatim.
 */
export function reconcile(input: ReconcileInput): ReconcileOutput {
	const { snapshot, remote, sources, foreign, now } = input;
	const local = toLocalHighlights(sources, foreign);

	const tombs: Tombstones = {
		highlights: { ...remote.tombstones.highlights },
		comments: { ...remote.tombstones.comments },
		drawings: { ...remote.tombstones.drawings },
		videoItems: { ...remote.tombstones.videoItems },
	};

	const mergedHighlights = mergeHighlightsStorage(snapshot.highlights, local, remote.highlights, tombs, now);

	const merged: SyncFile = {
		version: 1,
		highlights: mergedHighlights,
		drawings: remote.drawings,
		videoAnnotations: remote.videoAnnotations,
		tombstones: tombs,
	};

	const split = fromMergedHighlights(mergedHighlights);
	return { merged, sources: split.sources, foreign: split.foreign };
}
