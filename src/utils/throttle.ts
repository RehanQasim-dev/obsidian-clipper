// Leading + trailing throttle: invoke immediately, and if any calls arrive
// during the window, invoke once more with the latest args after it. The
// trailing edge matters — e.g. a burst of MutationObserver callbacks during
// SPA hydration must not have its final (decisive) call dropped, otherwise the
// post-hydration DOM state is never evaluated and highlight recovery never arms.
export function throttle<T extends (...args: any[]) => any>(func: T, limit: number): (...args: Parameters<T>) => void {
	let lastRun = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let lastArgs: Parameters<T> | null = null;
	let lastThis: any = null;
	return function(this: any, ...args: Parameters<T>) {
		lastArgs = args;
		lastThis = this;
		const remaining = limit - (Date.now() - lastRun);
		if (remaining <= 0) {
			if (timer) { clearTimeout(timer); timer = null; }
			lastRun = Date.now();
			func.apply(lastThis, lastArgs);
		} else if (!timer) {
			timer = setTimeout(() => {
				lastRun = Date.now();
				timer = null;
				func.apply(lastThis, lastArgs as Parameters<T>);
			}, remaining);
		}
	}
}