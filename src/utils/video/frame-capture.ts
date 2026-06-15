import browser from '../browser-polyfill';
import { VideoFrameImage } from './video-storage';

// Capture the current frame of a <video> as a downscaled JPEG. Tries a direct
// canvas draw first (fast, exact); if the canvas is tainted/blocked, falls back
// to a background captureVisibleTab screenshot cropped to the video's rect.

const MAX_WIDTH = 1280;
const JPEG_QUALITY = 0.8;

function downscaleSize(w: number, h: number): { w: number; h: number } {
	const scale = Math.min(1, MAX_WIDTH / Math.max(1, w));
	return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

// Path 1: draw the video element straight onto a canvas.
function captureViaCanvas(video: HTMLVideoElement): VideoFrameImage | null {
	const vw = video.videoWidth;
	const vh = video.videoHeight;
	if (!vw || !vh) return null;
	const { w, h } = downscaleSize(vw, vh);
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	try {
		ctx.drawImage(video, 0, 0, w, h);
		const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
		return { dataUrl, w, h };
	} catch {
		// SecurityError → canvas tainted; caller falls back.
		return null;
	}
}

// Path 2 (fallback): ask the background to screenshot the visible tab, then crop
// to the video's on-screen rectangle and downscale. Works regardless of canvas
// taint; in fullscreen the player fills the viewport so the crop is clean.
async function captureViaScreenshot(video: HTMLVideoElement): Promise<VideoFrameImage | null> {
	let res: { dataUrl?: string; error?: string } | undefined;
	try {
		res = await browser.runtime.sendMessage({ action: 'captureVisibleTab' }) as { dataUrl?: string; error?: string };
	} catch {
		return null;
	}
	if (!res?.dataUrl) return null;

	const img = new Image();
	const loaded = new Promise<boolean>((resolve) => {
		img.onload = () => resolve(true);
		img.onerror = () => resolve(false);
	});
	img.src = res.dataUrl;
	if (!(await loaded)) return null;

	const rect = video.getBoundingClientRect();
	const dpr = window.devicePixelRatio || 1;
	const sx = Math.max(0, rect.left * dpr);
	const sy = Math.max(0, rect.top * dpr);
	const sw = Math.max(1, rect.width * dpr);
	const sh = Math.max(1, rect.height * dpr);
	const { w, h } = downscaleSize(sw, sh);

	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	if (!ctx) return null;
	ctx.drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
	try {
		const dataUrl = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
		return { dataUrl, w, h };
	} catch {
		return null;
	}
}

export async function captureFrame(video: HTMLVideoElement): Promise<VideoFrameImage | null> {
	return captureViaCanvas(video) ?? await captureViaScreenshot(video);
}
