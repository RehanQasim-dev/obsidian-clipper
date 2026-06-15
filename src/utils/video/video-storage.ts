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

export type VideoColor = 'yellow' | 'red' | 'green';

export interface VideoStroke {
	id: string;
	color: VideoColor;
	// Flattened normalized points [x0,y0,x1,y1,...], each in 0..1 of the frame.
	points: number[];
}

export interface VideoLine {
	id: string;
	color: VideoColor;
	x1: number; y1: number; x2: number; y2: number; // normalized 0..1
}

export interface VideoText {
	id: string;
	color: VideoColor;
	x: number; y: number; // normalized 0..1, top-left of the label
	w: number;            // normalized 0..1 box width; text wraps within it
	text: string;
}

export interface VideoMarkup {
	strokes: VideoStroke[];
	lines: VideoLine[];
	texts: VideoText[];
}

export interface VideoFrameImage {
	dataUrl: string; // downscaled JPEG data URL
	w: number;       // natural pixel size of the captured (downscaled) frame
	h: number;
}

export interface VideoItem {
	id: string;
	kind: 'frame' | 'note';
	videoTime: number;            // seconds into the video
	frame?: VideoFrameImage;      // present only for kind:'frame'
	markup?: VideoMarkup;         // present only for kind:'frame' with drawings
	notes: string[];              // chat messages; "text<!--timestamp:N--><!--edited:M-->"
	updatedAt?: number;
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
	return { strokes: [], lines: [], texts: [] };
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
export async function upsertVideoItem(
	watchUrl: string,
	videoId: string,
	title: string | undefined,
	item: VideoItem,
): Promise<void> {
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
}

export async function updateVideoItemNotes(watchUrl: string, itemId: string, notes: string[]): Promise<void> {
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
}

export async function removeVideoItem(watchUrl: string, itemId: string): Promise<void> {
	const key = normalizeUrl(watchUrl);
	const all = await loadAllVideoData();
	const entry = all[key];
	if (!entry) return;
	entry.items = entry.items.filter(i => i.id !== itemId);
	if (entry.items.length === 0) delete all[key];
	else all[key] = entry;
	await browser.storage.local.set({ [STORAGE_KEY]: all });
}
