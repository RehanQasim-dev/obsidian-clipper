import { VideoFrameImage } from './video-storage';

// Shared "stage" pieces for the side-panel overlays (comments + transcript).
// When a panel opens we freeze the current moment as a captured frame and show
// it resized on the left, with a dim backdrop over the (untouched) live video
// behind it. Building our own frame image — rather than transforming YouTube's
// <video> — keeps it working identically in and out of fullscreen and avoids
// fighting the player's layout.

// A dim layer sized to the overlay (= the video's content rect). Sits behind the
// frame + panel so the live video reads as a dimmed backdrop.
export function buildDimBackdrop(): HTMLElement {
	const dim = document.createElement('div');
	dim.className = 'ob-vid-backdrop';
	return dim;
}

// The resized frame on the left. Reuses the annotator's frame styles (centered,
// aspect-correct, shadowed in comment mode); flex shrinks it as the panel docks.
export function buildFrameSide(frame: VideoFrameImage | null): HTMLElement {
	const wrap = document.createElement('div');
	wrap.className = 'ob-vid-frame-wrap';
	if (frame) {
		const inner = document.createElement('div');
		inner.className = 'ob-vid-frame-inner';
		inner.style.aspectRatio = `${frame.w} / ${frame.h}`;
		const img = document.createElement('img');
		img.className = 'ob-vid-frame';
		if (frame.dataUrl) img.src = frame.dataUrl;
		inner.appendChild(img);
		wrap.appendChild(inner);
	}
	return wrap;
}
