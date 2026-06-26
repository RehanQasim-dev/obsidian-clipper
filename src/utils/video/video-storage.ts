import { normalizeUrl } from '../highlighter';
import { deleteFrameImage } from './frame-store';
import { getPage, setPage, removePage, getAll } from '../page-store';

// Persistence for YouTube video annotations. Kept entirely separate from the
// page-highlight (`highlights`) and pencil (`drawings`) stores so the dashboard
// can route video entries down their own render path, and so the (potentially
// large) captured frame images never bloat the highlight/sync payloads.
//
// Keyed by normalizeUrl(watchUrl) — normalizeUrl already strips YouTube's `t`
// (timestamp) param, so every capture on a given video lands under one entry.
//
// Markup coords (strokes/lines/text) are stored NORMALIZED to 0..1 of the frame
// so they repaint correctly over the saved frame at any display size.

export type VideoColor = 'yellow' | 'red' | 'green' | 'black';

export type StrokeWidth = 'thin' | 'medium' | 'thick';

export interface VideoStroke {
	id: string;
	color: VideoColor;
	// Flattened normalized points [x0,y0,x1,y1,...], each in 0..1 of the frame.
	points: number[];
	weight?: StrokeWidth;
}

export interface VideoLine {
	id: string;
	color: VideoColor;
	x1: number; y1: number; x2: number; y2: number; // normalized 0..1
	weight?: StrokeWidth;
}

export interface VideoText {
	id: string;
	color: VideoColor;
	x: number; y: number; // normalized 0..1, top-left of the label
	w: number;            // normalized 0..1 box width; text wraps within it
	size?: number;        // size scale multiplier
	text: string;
}

export interface VideoRect {
	id: string;
	color: VideoColor;
	x: number; y: number; w: number; h: number; // normalized 0..1
	weight?: StrokeWidth;
}

export interface VideoArrow {
	id: string;
	color: VideoColor;
	x1: number; y1: number; x2: number; y2: number; // normalized 0..1
	weight?: StrokeWidth;
}

export interface VideoMarkup {
	strokes: VideoStroke[];
	lines: VideoLine[];
	texts: VideoText[];
	rects?: VideoRect[];
	arrows?: VideoArrow[];
}

export interface VideoFrameImage {
	// Runtime-only: the JPEG bytes live in IndexedDB (see frame-store.ts), keyed by
	// the item id, and are rehydrated on demand for display/export — they are never
	// persisted in the `video_annotations` blob. Optional because a freshly loaded
	// item carries metadata only until something fetches the image.
	dataUrl?: string;
	driveId?: string; // Drive blob id for cross-device sync of the image
	w: number;        // natural pixel size of the captured (downscaled) frame
	h: number;
}

// Anchors a transcript highlight back onto the caption track so it can be
// repainted when the transcript panel reopens. Caption cues are immutable per
// video, so (cue index + char offset) is a stable anchor — no fragile XPath.
export interface TranscriptAnchor {
	startCue: number; startOffset: number;
	endCue: number;   endOffset: number;
}

export interface VideoItem {
	id: string;
	kind: 'frame' | 'note' | 'transcript';
	videoTime: number;            // seconds into the video (range START for transcript)
	frame?: VideoFrameImage;      // present only for kind:'frame'
	markup?: VideoMarkup;         // present only for kind:'frame' with drawings
	notes: string[];              // chat messages; "text<!--timestamp:N--><!--edited:M-->"
	updatedAt?: number;
	// --- transcript-only fields ---
	timeEnd?: number;             // end of the last covered cue (range END)
	quote?: string;               // exact highlighted transcript text
	color?: VideoColor;           // highlight color
	anchor?: TranscriptAnchor;    // for repainting the highlight inline on reopen
	excalidrawScene?: any;        // Excalidraw scene elements/appState when using Excalidraw
}

export interface VideoAnnotationData {
	url: string;       // normalized watch URL (storage key)
	videoId: string;
	title?: string;
	items: VideoItem[];
}

export type VideoStorage = Record<string, VideoAnnotationData>;

export function emptyMarkup(): VideoMarkup {
	return { strokes: [], lines: [], texts: [], rects: [], arrows: [] };
}

export function genVideoId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function loadAllVideoData(): Promise<VideoStorage> {
	return getAll<VideoAnnotationData>('va');
}

export async function loadVideoData(url: string): Promise<VideoAnnotationData | null> {
	return getPage<VideoAnnotationData>('va', normalizeUrl(url));
}

// Add a new item or replace an existing one (matched by id) for a video.
let storageQueue: Promise<void> = Promise.resolve();

function enqueueWrite(task: () => Promise<void>): Promise<void> {
	storageQueue = storageQueue.then(task).catch(console.error);
	return storageQueue;
}

export function upsertVideoItem(
	watchUrl: string,
	videoId: string | undefined,
	title: string | undefined,
	item: VideoItem,
): Promise<void> {
	return enqueueWrite(async () => {
		const key = normalizeUrl(watchUrl);
		const entry: VideoAnnotationData = (await getPage<VideoAnnotationData>('va', key)) || { url: key, videoId: videoId as string, items: [] };
		if (title && !entry.title) entry.title = title;
		entry.videoId = videoId || entry.videoId;
		item.updatedAt = Date.now();
		// The JPEG bytes live in IndexedDB (frame-store), never in this blob — strip
		// any runtime dataUrl so it's never serialised here. Store a clone so the
		// caller's in-memory item keeps its image for display.
		const toStore: VideoItem = item.frame?.dataUrl
			? { ...item, frame: { ...item.frame, dataUrl: undefined } }
			: item;
		const idx = entry.items.findIndex(i => i.id === item.id);
		if (idx >= 0) entry.items[idx] = toStore;
		else entry.items.push(toStore);
		// Keep items ordered by video time so the dashboard timeline is correct.
		entry.items.sort((a, b) => a.videoTime - b.videoTime);
		await setPage<VideoAnnotationData>('va', key, entry);
	});
}

export function updateVideoItemNotes(watchUrl: string, itemId: string, notes: string[]): Promise<void> {
	return enqueueWrite(async () => {
		const key = normalizeUrl(watchUrl);
		const entry = await getPage<VideoAnnotationData>('va', key);
		if (!entry) return;
		const item = entry.items.find(i => i.id === itemId);
		if (!item) return;
		item.notes = notes;
		item.updatedAt = Date.now();
		await setPage<VideoAnnotationData>('va', key, entry);
	});
}

export function removeVideoItem(watchUrl: string, itemId: string): Promise<void> {
	return enqueueWrite(async () => {
		const key = normalizeUrl(watchUrl);
		const entry = await getPage<VideoAnnotationData>('va', key);
		if (!entry) return;
		entry.items = entry.items.filter(i => i.id !== itemId);
		if (entry.items.length === 0) await removePage('va', key);
		else await setPage<VideoAnnotationData>('va', key, entry);
		// Drop the frame image too so IndexedDB doesn't accumulate orphans.
		deleteFrameImage(itemId).catch(() => {});
	});
}
