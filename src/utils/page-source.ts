// Storage contract for captured page sources — the full readable page as
// Markdown, so the Obsidian note can carry the page *content* (the immutable
// "source"), not just the annotations. The Obsidian plugin renders this body in
// reading view and re-anchors highlights against it.
//
// This module is deliberately lightweight (no Defuddle import) so the background
// sync can read sources without pulling the markdown pipeline into its bundle.
// The actual capture lives in `page-source-capture.ts` (content-side only).

import { normalizeUrl } from './url-utils';

export const PAGE_SOURCES_KEY = 'page_sources';

export interface PageSource {
	url: string;
	title: string;
	markdown: string;
	capturedAt: number;
}

export type PageSources = Record<string, PageSource>;

/** The stored source for `url`, if any (read-only; safe in the background). */
export async function getPageSource(url: string): Promise<PageSource | undefined> {
	const key = normalizeUrl(url);
	const store = await browser.storage.local.get(PAGE_SOURCES_KEY);
	return (store[PAGE_SOURCES_KEY] as PageSources | undefined)?.[key];
}

/** Remove the stored source for `url`. */
export async function deletePageSource(url: string): Promise<void> {
	const key = normalizeUrl(url);
	const store = await browser.storage.local.get(PAGE_SOURCES_KEY);
	const sources = (store[PAGE_SOURCES_KEY] as PageSources | undefined);
	if (sources && sources[key]) {
		delete sources[key];
		await browser.storage.local.set({ [PAGE_SOURCES_KEY]: sources });
	}
}
