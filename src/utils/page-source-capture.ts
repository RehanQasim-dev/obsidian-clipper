// Content-side capture of the full readable page as Markdown (uses Defuddle, so
// it only belongs in the content bundle). Stored under `page_sources` keyed by
// normalized URL, written **once per page** — the source is immutable, so
// re-syncs only refresh the managed annotation region, never the source body.

import { parseForClip } from './clip-utils';
import { createMarkdownContent } from 'defuddle/full';
import { normalizeUrl } from './url-utils';
import { PAGE_SOURCES_KEY, type PageSources } from './page-source';

// Pages captured in this content-script session — avoids re-parsing on every save.
const capturedThisSession = new Set<string>();

/**
 * Capture the current document as Markdown and store it for `url` — but only if
 * we haven't already (the source is immutable). Best-effort and fire-and-forget:
 * any failure leaves annotations syncing as before.
 */
export async function capturePageSourceIfNeeded(url: string, fallbackTitle?: string): Promise<void> {
	const key = normalizeUrl(url);
	if (capturedThisSession.has(key)) return;
	capturedThisSession.add(key);

	try {
		const store = await browser.storage.local.get(PAGE_SOURCES_KEY);
		const sources = (store[PAGE_SOURCES_KEY] as PageSources | undefined) ?? {};
		if (sources[key]?.markdown) return; // already captured on a previous visit

		const defuddled = parseForClip(document);
		const markdown = createMarkdownContent(defuddled.content, document.URL);
		if (!markdown || !markdown.trim()) return;

		sources[key] = {
			url: key,
			title: defuddled.title || fallbackTitle || document.title || key,
			markdown,
			capturedAt: Date.now(),
		};
		await browser.storage.local.set({ [PAGE_SOURCES_KEY]: sources });
	} catch {
		// Parsing/storage failed — allow a retry on a later save this session.
		capturedThisSession.delete(key);
	}
}
