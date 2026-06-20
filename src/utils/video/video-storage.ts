import browser from '../browser-polyfill';
import { normalizeUrl } from '../highlighter';

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
	dataUrl: string; // downscaled JPEG data URL
	w: number;       // natural pixel size of the captured (downscaled) frame
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
}

export interface VideoAnnotationData {
	url: string;       // normalized watch URL (storage key)
	videoId: string;
	title?: string;
	items: VideoItem[];
}

export type VideoStorage = Record<string, VideoAnnotationData>;

const STORAGE_KEY = 'video_annotations';

export function emptyMarkup(): VideoMarkup {
	return { strokes: [], lines: [], texts: [], rects: [], arrows: [] };
}

export function genVideoId(): string {
	return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function loadAllVideoData(): Promise<VideoStorage> {
	const result = await browser.storage.local.get(STORAGE_KEY);
	return (result[STORAGE_KEY] || {}) as VideoStorage;
}

export async function loadVideoData(url: string): Promise<VideoAnnotationData | null> {
	const all = await loadAllVideoData();
	return all[normalizeUrl(url)] || null;
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
		const all = await loadAllVideoData();
		const entry: VideoAnnotationData = all[key] || { url: key, videoId, items: [] };
		if (title && !entry.title) entry.title = title;
		entry.videoId = videoId || entry.videoId;
		item.updatedAt = Date.now();
		const idx = entry.items.findIndex(i => i.id === item.id);
		if (idx >= 0) entry.items[idx] = item;
		else entry.items.push(item);
		// Keep items ordered by video time so the dashboard timeline is correct.
		entry.items.sort((a, b) => a.videoTime - b.videoTime);
		all[key] = entry;
		await browser.storage.local.set({ [STORAGE_KEY]: all });
	});
}

export function updateVideoItemNotes(watchUrl: string, itemId: string, notes: string[]): Promise<void> {
	return enqueueWrite(async () => {
		const key = normalizeUrl(watchUrl);
		const all = await loadAllVideoData();
		const entry = all[key];
		if (!entry) return;
		const item = entry.items.find(i => i.id === itemId);
		if (!item) return;
		item.notes = notes;
		item.updatedAt = Date.now();
		all[key] = entry;
		await browser.storage.local.set({ [STORAGE_KEY]: all });
	});
}

export function removeVideoItem(watchUrl: string, itemId: string): Promise<void> {
	return enqueueWrite(async () => {
		const key = normalizeUrl(watchUrl);
		const all = await loadAllVideoData();
		const entry = all[key];
		if (!entry) return;
		entry.items = entry.items.filter(i => i.id !== itemId);
		if (entry.items.length === 0) delete all[key];
		else all[key] = entry;
		await browser.storage.local.set({ [STORAGE_KEY]: all });
	});
}
