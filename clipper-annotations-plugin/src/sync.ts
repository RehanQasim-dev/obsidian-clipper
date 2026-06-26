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
	emptyPageRecord,
	type PageRecord,
	type Highlight,
	type Tombstones,
} from '../../shared/merge';
import type { AnnotationAnchor } from '../../shared/anchor';
import type { Annotation, CommentMsg, HighlightColor } from './store';

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

// --- per-page reconcile ------------------------------------------------------
//
// The plugin understands only *highlights*. For each page it merges the highlight
// list (so comments round-trip with the extension + live pages) and passes the
// extension's drawings / video items / diagrams — and their tombstones — through
// from the remote record VERBATIM. Highlights it can't render (no usable anchor)
// are kept in a per-page `foreign` bucket so they're never seen as deleted here.
// Image bytes are never touched: video frames and diagrams are pointers only.

export interface PageReconcileInput {
	url: string;
	title?: string;
	snapshot: PageRecord | null; // base (last reconciled for this page)
	remote: PageRecord | null; // current Drive state for this page
	annotations: Annotation[]; // this device's renderable annotations for the page
	foreign: Highlight[]; // highlights we couldn't render, preserved
	now: number;
}

export interface PageReconcileOutput {
	merged: PageRecord; // to upload + store as this page's new snapshot
	annotations: Annotation[]; // renderable, to write into the store
	foreign: Highlight[]; // to persist for next time
	title?: string;
}

export function reconcilePage(input: PageReconcileInput): PageReconcileOutput {
	const { url, now } = input;
	const base = input.snapshot ?? emptyPageRecord(url);
	const rem = input.remote ?? emptyPageRecord(url);

	// Local highlights = preserved foreign + our annotations (authoritative for their ids).
	const localHl: Highlight[] = [...input.foreign, ...input.annotations.map(annotationToHighlight)];

	// Merge only highlights + comments; seed tombstones from the remote record.
	const tombs: Tombstones = {
		highlights: { ...rem.tombstones.highlights },
		comments: { ...rem.tombstones.comments },
		drawings: { ...rem.tombstones.drawings },
		videoItems: { ...rem.tombstones.videoItems },
	};
	const mergedMap = mergeHighlightsStorage(
		{ [url]: { url, highlights: base.highlights } },
		{ [url]: { url, ...(input.title ? { title: input.title } : {}), highlights: localHl } },
		{ [url]: { url, ...(rem.title ? { title: rem.title } : {}), highlights: rem.highlights } },
		tombs,
		now,
	);
	const mergedHl = mergedMap[url]?.highlights ?? [];
	const title = mergedMap[url]?.title ?? input.title ?? rem.title ?? base.title;

	const merged: PageRecord = {
		version: 2,
		url,
		...(title ? { title } : {}),
		...(rem.videoId ? { videoId: rem.videoId } : {}),
		highlights: mergedHl,
		drawings: rem.drawings,       // pass through verbatim — plugin doesn't manage these
		videoItems: rem.videoItems,   // ditto
		diagrams: rem.diagrams,       // ditto (pointers only; no image bytes)
		tombstones: {
			highlights: tombs.highlights,
			comments: tombs.comments,
			drawings: rem.tombstones.drawings,
			videoItems: rem.tombstones.videoItems,
			diagrams: rem.tombstones.diagrams,
		},
	};

	// Split the merged highlights into renderable annotations + preserved foreign.
	const annotations: Annotation[] = [];
	const foreign: Highlight[] = [];
	for (const h of mergedHl) {
		const ann = highlightToAnnotation(h, url);
		if (ann) annotations.push(ann);
		else foreign.push(h);
	}
	return { merged, annotations, foreign, title };
}
