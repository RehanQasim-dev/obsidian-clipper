// YouTube watch-page detection and player access. Everything here rides web
// standards (the <video> element + its bounding box) rather than YouTube's
// churning CSS class names, so it degrades gracefully across YouTube redesigns.

export function isYouTubeWatchPage(): boolean {
	const h = location.hostname;
	return (h === 'www.youtube.com' || h === 'youtube.com' || h === 'm.youtube.com')
		&& location.pathname === '/watch';
}

export function getVideoId(): string {
	try {
		return new URLSearchParams(location.search).get('v') || '';
	} catch {
		return '';
	}
}

// The main playback <video>. YouTube tags it .html5-main-video; fall back to the
// first/biggest <video> on the page so we keep working if that class changes.
export function getVideoElement(): HTMLVideoElement | null {
	const main = document.querySelector<HTMLVideoElement>('video.html5-main-video');
	if (main) return main;
	const vids = Array.from(document.querySelectorAll('video'));
	if (vids.length === 0) return null;
	// Pick the largest by displayed area (avoids tiny preview/ad videos).
	return vids.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
}

// Best-effort container for mounting the overlay when NOT fullscreen. The
// annotator prefers document.fullscreenElement when present.
export function getPlayerContainer(): HTMLElement | null {
	return document.querySelector<HTMLElement>('#movie_player')
		|| document.querySelector<HTMLElement>('.html5-video-player')
		|| (getVideoElement()?.parentElement ?? null);
}

export function getVideoTitle(): string {
	const h1 = document.querySelector<HTMLElement>('h1.ytd-watch-metadata, h1.title');
	const fromDom = h1?.textContent?.trim();
	if (fromDom) return fromDom;
	return document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
}

// Subscribe to YouTube SPA navigation (it swaps videos without a full reload).
// Returns an unsubscribe fn. Uses YouTube's own event plus a URL-polling
// fallback in case the event name changes.
export function onYouTubeNavigate(cb: () => void): () => void {
	let lastHref = location.href;
	const onEvent = () => {
		if (location.href !== lastHref) {
			lastHref = location.href;
			cb();
		}
	};
	document.addEventListener('yt-navigate-finish', onEvent as EventListener);
	const interval = window.setInterval(onEvent, 1000);
	return () => {
		document.removeEventListener('yt-navigate-finish', onEvent as EventListener);
		window.clearInterval(interval);
	};
}
