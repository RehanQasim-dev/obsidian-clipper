import browser from '../utils/browser-polyfill';
import { AnyHighlightData, StoredData, DomainSettings, collapseGroupsForExport, normalizeUrl } from '../utils/highlighter';
import { translatePage, getMessage, setupLanguageAndDirection } from '../utils/i18n';
import { addBrowserClassToHtml, detectBrowser } from '../utils/browser-detection';
import DOMPurify from 'dompurify';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { getFontCss } from '../utils/font-utils';
import { ReaderSettings } from '../types/types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { createIcons } from 'lucide';
import { icons } from '../icons/icons';
import { initializeMenu } from '../managers/menu';
import { loadAllVideoData, removeVideoItem, VideoItem } from '../utils/video/video-storage';
import { createVideoItemCard } from './video-highlights';

dayjs.extend(relativeTime);

// A video annotation item is carried through the dashboard's HighlightEntry model
// by stashing it on the entry data under this key; createHighlightItem routes any
// entry carrying it to the video card renderer.
interface VideoCarrier { __video?: VideoItem }

interface DomainGroup {
	domain: string;
	pages: PageGroup[];
	totalHighlights: number;
}

interface PageGroup {
	url: string;
	path: string;
	title?: string;
	highlights: HighlightEntry[];
}

interface HighlightEntry {
	data: AnyHighlightData;
	url: string;
}

// Navigation state: what the user is viewing
type NavSelection =
	| { type: 'all' }
	| { type: 'domain'; domain: string }
	| { type: 'page'; domain: string; url: string };

type SortOrder = 'az' | 'za' | 'new' | 'old';

let allDomainGroups: DomainGroup[] = [];
let domainSettingsMap: Record<string, DomainSettings> = {};
let searchQueryWebsites = '';
let searchQueryHighlights = '';
let currentNav: NavSelection = { type: 'all' };
let expandedSidebarDomains = new Set<string>();
let sortOrder: SortOrder = 'az';
const faviconCache = new Map<string, HTMLImageElement>();

// Batched rendering
const BATCH_SIZE = 50;
// Each entry in flatEntries is one render unit — a single highlight, or a
// group of highlights sharing a groupId that should render as one card.
interface RenderUnit { entries: HighlightEntry[]; pageUrl: string; domain: string; title?: string }
let flatEntries: RenderUnit[] = [];
let renderedCount = 0;
let currentPageGroup: HTMLElement | null = null;
let observer: IntersectionObserver | null = null;

document.addEventListener('DOMContentLoaded', async () => {
	await setupLanguageAndDirection();
	await translatePage();
	addBrowserClassToHtml();
	await applyReaderTheme();

	currentNav = readNavFromUrl();
	await loadData();
	// Auto-expand the domain in sidebar if navigating to a specific domain or page
	if (currentNav.type === 'domain' || currentNav.type === 'page') {
		expandedSidebarDomains.add(currentNav.domain);
	}
	renderSidebar();
	renderMain();

	const searchWebsites = document.getElementById('highlights-search-websites') as HTMLInputElement;
	if (searchWebsites) {
		searchWebsites.addEventListener('input', () => {
			searchQueryWebsites = searchWebsites.value.toLowerCase().trim();
			renderSidebar();
			renderMain();
		});
	}

	const searchHighlights = document.getElementById('highlights-search-highlights') as HTMLInputElement;
	if (searchHighlights) {
		searchHighlights.addEventListener('input', () => {
			searchQueryHighlights = searchHighlights.value.toLowerCase().trim();
			renderSidebar();
			renderMain();
		});
	}

	const deleteBtn = document.getElementById('delete-context-btn') as HTMLButtonElement;
	deleteBtn.addEventListener('click', deleteCurrentContext);

	const exportBtn = document.getElementById('export-context-btn') as HTMLButtonElement;
	exportBtn.addEventListener('click', exportCurrentContext);

	initializeMenu('highlights-sort-btn', 'highlights-sort-menu');
	const sortMenu = document.getElementById('highlights-sort-menu')!;
	sortMenu.querySelectorAll<HTMLElement>('.menu-item[data-sort]').forEach(item => {
		item.addEventListener('click', () => {
			const value = item.dataset.sort as SortOrder;
			if (value === sortOrder) return;
			sortOrder = value;
			updateSortMenuActiveState();
			renderSidebar();
		});
	});
	updateSortMenuActiveState();

	const sidebarTitle = document.getElementById('highlights-sidebar-title');
	sidebarTitle?.addEventListener('click', () => navigate({ type: 'all' }));

	const settingsLink = document.getElementById('highlights-settings-link');
	settingsLink?.addEventListener('click', (e) => e.stopPropagation());

	const navbarTitle = document.getElementById('highlights-navbar-title');
	navbarTitle?.addEventListener('click', () => navigate({ type: 'all' }));

	// Mobile hamburger
	const hamburger = document.getElementById('highlights-hamburger');
	const container = document.getElementById('highlights');
	if (hamburger && container) {
		hamburger.addEventListener('click', () => {
			container.classList.toggle('sidebar-open');
			hamburger.classList.toggle('is-active');
		});
	}

	// Listen for storage changes
	browser.storage.onChanged.addListener((changes, area) => {
		if (area === 'local' && (changes.highlights || changes.video_annotations)) {
			loadData().then(() => {
				if (!updateSidebarCounts()) {
					renderSidebar();
				}
				if (!updateMainIncremental()) {
					renderMain();
				}
			});
		}
		if (area === 'sync' && changes.reader_settings) {
			applyReaderTheme().then(() => {
				reapplyThemeToPageGroups();
			});
		}
	});

	// Set up sentinel observer for infinite scroll
	const sentinel = document.getElementById('highlights-sentinel')!;
	observer = new IntersectionObserver((entries) => {
		if (entries[0].isIntersecting) {
			renderNextBatch();
		}
	}, { rootMargin: '200px' });
	observer.observe(sentinel);

	createIcons({ icons });
});

// --- Reader theme ---

let highlightThemeClasses: string[] = [];
let highlightThemeAttr: { name: string; value: string } | null = null;

async function applyReaderTheme() {
	const data = await browser.storage.sync.get('reader_settings');
	const settings = data.reader_settings as ReaderSettings | undefined;

	const isDark = settings
		? settings.appearance === 'dark' || (settings.appearance === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches)
		: window.matchMedia('(prefers-color-scheme: dark)').matches;

	highlightThemeClasses = ['obsidian-reader-active', isDark ? 'theme-dark' : 'theme-light'];

	if (settings) {
		const effectiveTheme = isDark && settings.darkTheme !== 'same' ? settings.darkTheme : settings.lightTheme;
		highlightThemeAttr = effectiveTheme && effectiveTheme !== 'default'
			? { name: 'data-reader-theme', value: effectiveTheme }
			: null;

		// Font settings apply globally
		const html = document.documentElement;
		html.style.setProperty('--font-text-size', `${settings.fontSize}px`);
		html.style.setProperty('--line-height-normal', settings.lineHeight.toString());

		const fontCss = getFontCss(settings.defaultFont);
		if (fontCss) {
			document.body.style.setProperty('--font-text', fontCss);
		}
	}
}

function applyThemeToElement(el: HTMLElement) {
	el.classList.remove('theme-dark', 'theme-light');
	el.removeAttribute('data-reader-theme');
	for (const cls of highlightThemeClasses) {
		el.classList.add(cls);
	}
	if (highlightThemeAttr) {
		el.setAttribute(highlightThemeAttr.name, highlightThemeAttr.value);
	}
}

function reapplyThemeToPageGroups() {
	const groups = document.querySelectorAll<HTMLElement>('.highlight-page-group');
	groups.forEach(el => applyThemeToElement(el));
}

// --- Data loading ---

async function loadData() {
	const result = await browser.storage.local.get(['highlights', 'domains']);
	const allHighlights = (result.highlights || {}) as Record<string, StoredData>;
	domainSettingsMap = (result.domains || {}) as Record<string, DomainSettings>;

	// Merge entries that normalize to the same URL
	const mergedMap = new Map<string, { stored: StoredData; originalKeys: string[] }>();
	for (const [urlKey, stored] of Object.entries(allHighlights)) {
		if (!stored.highlights || stored.highlights.length === 0) continue;
		const normUrl = normalizeUrl(stored.url || urlKey);
		const existing = mergedMap.get(normUrl);
		if (existing) {
			// Merge highlights, keep best title
			existing.stored.highlights = [...existing.stored.highlights, ...stored.highlights];
			if (!existing.stored.title && stored.title) existing.stored.title = stored.title;
			existing.originalKeys.push(urlKey);
		} else {
			mergedMap.set(normUrl, {
				stored: { ...stored, url: normUrl, highlights: [...stored.highlights] },
				originalKeys: [urlKey],
			});
		}
	}

	// Persist merges if any duplicates were found
	let needsSave = false;
	for (const [normUrl, { stored, originalKeys }] of mergedMap) {
		if (originalKeys.length > 1 || originalKeys[0] !== normUrl) {
			needsSave = true;
			for (const key of originalKeys) {
				if (key !== normUrl) delete allHighlights[key];
			}
			allHighlights[normUrl] = stored;
		}
	}
	if (needsSave) {
		browser.storage.local.set({ highlights: allHighlights });
	}

	const domainMap = new Map<string, PageGroup[]>();

	for (const [, { stored }] of mergedMap) {
		let domain: string;
		let path: string;
		try {
			const parsed = new URL(stored.url);
			domain = parsed.hostname.replace(/^www\./, '');
			path = parsed.pathname + parsed.search;
		} catch {
			domain = stored.url;
			path = '/';
		}

		if (!domainMap.has(domain)) {
			domainMap.set(domain, []);
		}

		domainMap.get(domain)!.push({
			url: stored.url,
			path,
			title: stored.title,
			highlights: stored.highlights.map(h => ({ data: h, url: stored.url })),
		});
	}

	allDomainGroups = Array.from(domainMap.entries())
		.map(([domain, pages]) => ({
			domain,
			pages: pages.sort((a, b) => a.path.localeCompare(b.path)),
			totalHighlights: pages.reduce((sum, p) => sum + p.highlights.length, 0),
		}));

	// Fold in YouTube video annotations as their own per-video page groups so they
	// flow through the same sidebar/timeline/render pipeline as web highlights.
	await mergeVideoIntoGroups();

	// If current nav references something that no longer exists, reset
	const nav = currentNav;
	if (nav.type === 'domain') {
		if (!allDomainGroups.find(g => g.domain === nav.domain)) {
			currentNav = { type: 'all' };
		}
	} else if (nav.type === 'page') {
		const group = allDomainGroups.find(g => g.domain === nav.domain);
		if (!group || !group.pages.find(p => p.url === nav.url)) {
			currentNav = { type: 'all' };
		}
	}
}

// Load YouTube video annotations and append each video as its own page group
// (under its domain) so they render through the existing pipeline. Each video
// item becomes a HighlightEntry carrying the VideoItem for the card renderer.
async function mergeVideoIntoGroups(): Promise<void> {
	const all = await loadAllVideoData();
	const byDomain = new Map<string, PageGroup[]>();
	for (const [url, data] of Object.entries(all)) {
		if (!data.items || data.items.length === 0) continue;
		let domain = 'youtube.com';
		try { domain = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep default */ }
		const highlights: HighlightEntry[] = data.items.map(item => ({
			url,
			data: {
				type: 'text', id: item.id, xpath: '', startOffset: 0, endOffset: 0,
				content: '', notes: item.notes, __video: item,
			} as unknown as AnyHighlightData,
		}));
		const pg: PageGroup = { url, path: '/watch', title: data.title, highlights };
		if (!byDomain.has(domain)) byDomain.set(domain, []);
		byDomain.get(domain)!.push(pg);
	}
	for (const [domain, pages] of byDomain) {
		let g = allDomainGroups.find(x => x.domain === domain);
		if (!g) { g = { domain, pages: [], totalHighlights: 0 }; allDomainGroups.push(g); }
		g.pages.push(...pages);
		g.totalHighlights += pages.reduce((s, p) => s + p.highlights.length, 0);
	}
}

// --- Search ---

function matchesSearch(entry: HighlightEntry): boolean {
	if (!searchQueryHighlights) return true;
	const content = entry.data.content?.toLowerCase() || '';
	const notes = entry.data.notes?.join(' ').toLowerCase() || '';
	const url = entry.url.toLowerCase();
	return content.includes(searchQueryHighlights) || notes.includes(searchQueryHighlights) || url.includes(searchQueryHighlights);
}

function getFilteredGroups(): DomainGroup[] {
	if (!searchQueryWebsites && !searchQueryHighlights) return sortGroups([...allDomainGroups]);

	const filtered: DomainGroup[] = [];
	for (const group of allDomainGroups) {
		const normalized = group.domain.replace(/^www\./, '');
		const siteName = domainSettingsMap[normalized]?.site?.toLowerCase() || '';
		
		const domainMatches = !searchQueryWebsites || group.domain.toLowerCase().includes(searchQueryWebsites) || siteName.includes(searchQueryWebsites);

		if (!domainMatches) continue;

		const filteredPages: PageGroup[] = [];
		for (const page of group.pages) {
			const titleMatches = !searchQueryHighlights || (page.title?.toLowerCase().includes(searchQueryHighlights) || false);

			if (titleMatches) {
				filteredPages.push(page);
			} else {
				const filteredHighlights = page.highlights.filter(matchesSearch);
				if (filteredHighlights.length > 0 || !searchQueryHighlights) {
					filteredPages.push({ ...page, highlights: filteredHighlights.length > 0 ? filteredHighlights : page.highlights });
				}
			}
		}
		if (filteredPages.length > 0) {
			filtered.push({
				...group,
				pages: filteredPages,
				totalHighlights: filteredPages.reduce((sum, p) => sum + p.highlights.length, 0),
			});
		}
	}
	return sortGroups(filtered);
}

function newestTimestamp(group: DomainGroup): number {
	let max = 0;
	for (const page of group.pages) {
		for (const h of page.highlights) {
			const t = parseInt(h.data.id) || 0;
			if (t > max) max = t;
		}
	}
	return max;
}

function oldestTimestamp(group: DomainGroup): number {
	let min = Infinity;
	for (const page of group.pages) {
		for (const h of page.highlights) {
			const t = parseInt(h.data.id) || Infinity;
			if (t < min) min = t;
		}
	}
	return min;
}

function sortGroups(groups: DomainGroup[]): DomainGroup[] {
	switch (sortOrder) {
		case 'az':
			return groups.sort((a, b) => displayDomain(a.domain).localeCompare(displayDomain(b.domain)));
		case 'za':
			return groups.sort((a, b) => displayDomain(b.domain).localeCompare(displayDomain(a.domain)));
		case 'new':
			return groups.sort((a, b) => newestTimestamp(b) - newestTimestamp(a));
		case 'old':
			return groups.sort((a, b) => oldestTimestamp(a) - oldestTimestamp(b));
	}
}

// --- Sidebar ---

function navigate(nav: NavSelection) {
	currentNav = nav;
	updateUrlFromNav();
	updateSidebarActiveState();
	renderMain();

	// Close mobile sidebar
	const container = document.getElementById('highlights');
	const hamburger = document.getElementById('highlights-hamburger');
	container?.classList.remove('sidebar-open');
	hamburger?.classList.remove('is-active');
}

function updateSortMenuActiveState() {
	const menu = document.getElementById('highlights-sort-menu');
	if (!menu) return;
	menu.querySelectorAll<HTMLElement>('.menu-item[data-sort]').forEach(item => {
		item.classList.toggle('is-active', item.dataset.sort === sortOrder);
	});
}

function updateSidebarActiveState() {
	const domainListEl = document.getElementById('highlights-domain-list')!;
	domainListEl.querySelectorAll('.nav-domain').forEach(li => {
		const domain = li.getAttribute('data-domain');
		li.classList.toggle('active', currentNav.type === 'domain' && currentNav.domain === domain);
	});
	domainListEl.querySelectorAll('.nav-page').forEach(li => {
		const url = li.getAttribute('data-url');
		li.classList.toggle('active', currentNav.type === 'page' && (currentNav as { url: string }).url === url);
	});
}

function updateUrlFromNav() {
	const params = new URLSearchParams();
	if (currentNav.type === 'domain') {
		params.set('domain', currentNav.domain);
	} else if (currentNav.type === 'page') {
		params.set('domain', currentNav.domain);
		params.set('url', currentNav.url);
	}
	const search = params.toString();
	const newUrl = window.location.pathname + (search ? '?' + search : '');
	window.history.replaceState({}, '', newUrl);
}

function readNavFromUrl(): NavSelection {
	const params = new URLSearchParams(window.location.search);
	const domain = params.get('domain')?.replace(/^www\./, '');
	const url = params.get('url');
	if (url && domain) {
		return { type: 'page', domain, url };
	} else if (domain) {
		return { type: 'domain', domain };
	}
	return { type: 'all' };
}

function createPageSubItems(group: DomainGroup): HTMLElement[] {
	const items: HTMLElement[] = [];
	for (const page of group.pages) {
		const isPageActive = currentNav.type === 'page'
			&& (currentNav as { domain: string; url: string }).domain === group.domain
			&& (currentNav as { url: string }).url === page.url;

		const pageLi = document.createElement('li');
		pageLi.className = 'nav-page' + (isPageActive ? ' active' : '');
		pageLi.setAttribute('data-url', page.url);

		const pageName = document.createElement('span');
		pageName.className = 'nav-page-name';
		pageName.textContent = page.title || displayPath(page.path);
		pageName.title = page.url;
		pageLi.appendChild(pageName);

		const pageCount = document.createElement('span');
		pageCount.className = 'nav-count';
		pageCount.textContent = String(page.highlights.length);
		pageLi.appendChild(pageCount);

		pageLi.addEventListener('click', (e) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				window.open(page.url, '_blank');
				return;
			}
			e.stopPropagation();
			navigate({ type: 'page', domain: group.domain, url: page.url });
		});

		items.push(pageLi);
	}
	return items;
}

// Update sidebar counts in-place without a full rebuild.
// Returns true if successful, false if a full renderSidebar() is needed.
function updateSidebarCounts(): boolean {
	const domainListEl = document.getElementById('highlights-domain-list')!;
	const filtered = getFilteredGroups();
	const groupMap = new Map<string, DomainGroup>();
	const pageCountMap = new Map<string, number>();
	for (const g of filtered) {
		groupMap.set(g.domain, g);
		for (const p of g.pages) pageCountMap.set(p.url, p.highlights.length);
	}

	// Check that rendered domains match filtered domains
	const domainItems = Array.from(domainListEl.querySelectorAll<HTMLElement>('.nav-domain'));
	if (domainItems.length !== filtered.length) return false;
	for (const group of filtered) {
		const cached = sidebarNodeCache.get(group.domain);
		if (!cached) return false;
		cached.countEl.textContent = String(group.totalHighlights);
	}

	// Page sub-items aren't cached, so query the DOM
	const pageItems = Array.from(domainListEl.querySelectorAll<HTMLElement>('.nav-page'));
	for (let i = 0; i < pageItems.length; i++) {
		const count = pageCountMap.get(pageItems[i].getAttribute('data-url')!);
		if (count !== undefined) {
			const countEl = pageItems[i].querySelector('.nav-count');
			if (countEl) countEl.textContent = String(count);
		}
	}

	return true;
}

interface CachedDomainNode {
	li: HTMLElement;
	countEl: Element;
	chevronWrap: Element;
}
const sidebarNodeCache = new Map<string, CachedDomainNode>();

function renderSidebar() {
	const domainListEl = document.getElementById('highlights-domain-list')!;
	const filtered = getFilteredGroups();

	// Detach children without destroying cached nodes
	domainListEl.replaceChildren();

	// Prune cache entries for domains no longer in data
	const activeDomains = new Set(allDomainGroups.map(g => g.domain));
	for (const domain of sidebarNodeCache.keys()) {
		if (!activeDomains.has(domain)) sidebarNodeCache.delete(domain);
	}

	let needsIcons = false;

	for (const group of filtered) {
		let cached = sidebarNodeCache.get(group.domain);
		if (!cached) {
			cached = createDomainNode(group.domain);
			sidebarNodeCache.set(group.domain, cached);
			needsIcons = true;
		}

		const isDomainActive = currentNav.type === 'domain' && currentNav.domain === group.domain;
		cached.li.classList.toggle('active', isDomainActive);
		cached.countEl.textContent = String(group.totalHighlights);

		domainListEl.appendChild(cached.li);
	}

	if (needsIcons) createIcons({ icons });
}

function createDomainNode(domain: string): CachedDomainNode {
	const li = document.createElement('li');
	li.className = 'nav-domain';
	li.setAttribute('data-domain', domain);

	// Sidebar is a flat sources list — no chevron trees. Clicking a source filters
	// the main pane; its pages appear there as section headers, not in the sidebar.
	// (chevronWrap kept off-DOM only to satisfy the cache shape.)
	const chevronWrap = document.createElement('div');
	chevronWrap.className = 'nav-chevron-wrap';

	const normalized = domain.replace(/^www\./, '');
	const domainSettings = domainSettingsMap[normalized];
	const siteName = domainSettings?.site;

	if (domainSettings?.favicon) {
		let favicon = faviconCache.get(normalized);
		if (!favicon) {
			favicon = document.createElement('img');
			favicon.className = 'nav-domain-favicon';
			favicon.src = domainSettings.favicon;
			favicon.width = 16;
			favicon.height = 16;
			favicon.onerror = () => {
				const globe = document.createElement('i');
				globe.className = 'nav-domain-favicon';
				globe.setAttribute('data-lucide', 'globe');
				favicon!.replaceWith(globe);
				createIcons({ icons });
			};
			faviconCache.set(normalized, favicon);
		}
		li.appendChild(favicon.cloneNode(true));
	} else {
		const globe = document.createElement('i');
		globe.className = 'nav-domain-favicon';
		globe.setAttribute('data-lucide', 'globe');
		li.appendChild(globe);
	}

	const name = document.createElement('span');
	name.className = 'nav-domain-name';
	name.textContent = siteName || displayDomain(domain);
	if (siteName) name.title = displayDomain(domain);
	li.appendChild(name);

	const count = document.createElement('span');
	count.className = 'nav-count';
	li.appendChild(count);

	li.addEventListener('click', (e) => {
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			window.open(`https://${domain}`, '_blank');
			return;
		}
		// Always filter the main pane to this source.
		navigate({ type: 'domain', domain });
	});

	return { li, countEl: count, chevronWrap };
}

function toggleDomainExpand(domain: string) {
	const cached = sidebarNodeCache.get(domain);
	if (!cached) return;
	const { li, chevronWrap } = cached;
	if (expandedSidebarDomains.has(domain)) {
		expandedSidebarDomains.delete(domain);
		chevronWrap.classList.remove('is-expanded');
		let next = li.nextElementSibling;
		while (next && next.classList.contains('nav-page')) {
			const toRemove = next;
			next = next.nextElementSibling;
			toRemove.remove();
		}
	} else {
		expandedSidebarDomains.add(domain);
		chevronWrap.classList.add('is-expanded');
		const group = getFilteredGroups().find(g => g.domain === domain);
		if (group) {
			let insertAfter: Element = li;
			for (const pageLi of createPageSubItems(group)) {
				insertAfter.after(pageLi);
				insertAfter = pageLi;
			}
			createIcons({ icons });
		}
	}
}

// --- Main content ---

// Collapse group members (from a multi-block selection) into a single render
// unit so the highlights page shows them as one card. Preserves order and
// groups across the page the selection originated in.
function collapseGroupsForRender(
	entries: { entry: HighlightEntry; pageUrl: string; domain: string; title?: string }[]
): RenderUnit[] {
	const units: RenderUnit[] = [];
	const byKey = new Map<string, RenderUnit>(); // pageUrl::groupId → unit
	for (const e of entries) {
		const gid = e.entry.data.groupId;
		if (gid) {
			const key = `${e.pageUrl}::${gid}`;
			const existing = byKey.get(key);
			if (existing) {
				existing.entries.push(e.entry);
				continue;
			}
			const unit: RenderUnit = { entries: [e.entry], pageUrl: e.pageUrl, domain: e.domain, title: e.title };
			byKey.set(key, unit);
			units.push(unit);
		} else {
			units.push({ entries: [e.entry], pageUrl: e.pageUrl, domain: e.domain, title: e.title });
		}
	}
	return units;
}

function getVisibleEntries(): { entry: HighlightEntry; pageUrl: string; domain: string; title?: string }[] {
	const filtered = getFilteredGroups();
	const nav = currentNav;
	const entries: { entry: HighlightEntry; pageUrl: string; domain: string; title?: string }[] = [];

	for (const group of filtered) {
		if (nav.type === 'domain' && nav.domain !== group.domain) continue;
		if (nav.type === 'page' && nav.domain !== group.domain) continue;

		for (const page of group.pages) {
			if (nav.type === 'page' && nav.url !== page.url) continue;

			for (const highlight of page.highlights) {
				entries.push({ entry: highlight, pageUrl: page.url, domain: group.domain, title: page.title });
			}
		}
	}

	// Page groups newest first; within-page order preserved (stable sort)
	const pageNewest = new Map<string, number>();
	for (const e of entries) {
		const t = parseInt(e.entry.data.id) || 0;
		pageNewest.set(e.pageUrl, Math.max(pageNewest.get(e.pageUrl) || 0, t));
	}
	entries.sort((a, b) => {
		if (a.pageUrl === b.pageUrl) return 0;
		return (pageNewest.get(b.pageUrl) || 0) - (pageNewest.get(a.pageUrl) || 0);
	});

	return entries;
}

// Patch the main content in-place instead of tearing down and rebuilding.
// Returns true if the incremental update succeeded, false to fall back to renderMain().
function updateMainIncremental(): boolean {
	const listEl = document.getElementById('highlights-list')!;
	const newFlatEntries = collapseGroupsForRender(getVisibleEntries());

	const oldKeys = new Set<string>();
	for (let i = 0; i < renderedCount; i++) {
		oldKeys.add(unitKey(flatEntries[i].entries));
	}

	// Compute keys once for new entries, then derive added/removed
	const newKeyList: string[] = [];
	const newKeySet = new Set<string>();
	for (const unit of newFlatEntries) {
		const key = unitKey(unit.entries);
		newKeyList.push(key);
		newKeySet.add(key);
	}

	const addedKeySet = new Set<string>();
	const added: RenderUnit[] = [];
	for (let i = 0; i < newFlatEntries.length; i++) {
		if (!oldKeys.has(newKeyList[i])) {
			addedKeySet.add(newKeyList[i]);
			added.push(newFlatEntries[i]);
		}
	}
	const removedKeys: string[] = [];
	for (const key of oldKeys) {
		if (!newKeySet.has(key)) removedKeys.push(key);
	}

	if (added.length === 0 && removedKeys.length === 0) {
		flatEntries = newFlatEntries;
		return true;
	}

	for (const key of removedKeys) {
		const el = listEl.querySelector<HTMLElement>(`.highlight-item[data-unit-key="${CSS.escape(key)}"]`);
		if (!el) return false;
		const group = el.closest<HTMLElement>('.highlight-page-group');
		el.remove();
		if (group && !group.querySelector('.highlight-item')) {
			group.remove();
		}
	}

	// Insert new highlights in correct DOM-position order
	const pagesWithAdds = new Set(added.map(u => u.pageUrl));

	for (const pageUrl of pagesWithAdds) {
		let group = listEl.querySelector<HTMLElement>(`.highlight-page-group[data-page-url="${CSS.escape(pageUrl)}"]`);
		if (!group) {
			const sample = added.find(u => u.pageUrl === pageUrl)!;
			group = createPageGroupWrapper(pageUrl);
			const header = createPageHeader(pageUrl, sample.domain, sample.title);
			group.appendChild(header);
			listEl.insertBefore(group, listEl.firstChild);
		}

		// Walk desired order and insert before the next existing sibling
		const pageUnits = newFlatEntries.filter(u => u.pageUrl === pageUrl);
		for (let i = 0; i < pageUnits.length; i++) {
			const key = unitKey(pageUnits[i].entries);
			if (!addedKeySet.has(key)) continue;

			let refEl: HTMLElement | null = null;
			for (let j = i + 1; j < pageUnits.length; j++) {
				const sibKey = unitKey(pageUnits[j].entries);
				if (!addedKeySet.has(sibKey)) {
					refEl = group.querySelector<HTMLElement>(`.highlight-item[data-unit-key="${CSS.escape(sibKey)}"]`);
					if (refEl) break;
				}
			}

			const card = createHighlightItem(pageUnits[i].entries, pageUrl);
			group.insertBefore(card, refEl);
		}
	}

	flatEntries = newFlatEntries;
	renderedCount = Math.min(renderedCount + added.length - removedKeys.length, flatEntries.length);
	if (renderedCount < 0) renderedCount = 0;

	createIcons({ icons });
	return true;
}

function renderMain() {
	const listEl = document.getElementById('highlights-list')!;
	const emptyEl = document.getElementById('highlights-empty')!;
	const deleteBtn = document.getElementById('delete-context-btn')!;
	const exportBtn = document.getElementById('export-context-btn')!;

	listEl.textContent = '';
	renderedCount = 0;
	currentPageGroup = null;

	flatEntries = collapseGroupsForRender(getVisibleEntries());

	// Breadcrumb
	renderBreadcrumb();

	// Delete button label
	updateDeleteButton();

	if (flatEntries.length === 0) {
		emptyEl.style.display = '';
		const noData = allDomainGroups.length === 0;
		deleteBtn.style.display = noData ? 'none' : '';
		exportBtn.style.display = noData ? 'none' : '';
		return;
	}

	emptyEl.style.display = 'none';
	deleteBtn.style.display = '';
	exportBtn.style.display = '';

	// Show page in same format as multi-page view
	const nav = currentNav;
	if (nav.type === 'page') {
		const pageGroup = allDomainGroups
			.find(g => g.domain === nav.domain)?.pages
			.find(p => p.url === nav.url);

		currentPageGroup = createPageGroupWrapper(nav.url);
		listEl.appendChild(currentPageGroup);
		const pageHeader = createPageHeader(nav.url, nav.domain, pageGroup?.title);
		currentPageGroup.appendChild(pageHeader);

		renderNextBatch();
		createIcons({ icons });
		return;
	}

	renderNextBatch();
}

function createPageGroupWrapper(pageUrl: string): HTMLElement {
	const wrapper = document.createElement('div');
	wrapper.className = 'highlight-page-group';
	wrapper.setAttribute('data-page-url', pageUrl);
	applyThemeToElement(wrapper);
	return wrapper;
}

function renderNextBatch() {
	const listEl = document.getElementById('highlights-list')!;
	const end = Math.min(renderedCount + BATCH_SIZE, flatEntries.length);

	if (renderedCount >= flatEntries.length) return;

	// Track which page group we're in to insert page headers
	let lastPageUrl = renderedCount > 0 ? flatEntries[renderedCount - 1].pageUrl : null;

	// For single-page view, ensure we have a group wrapper
	if (currentNav.type === 'page' && !currentPageGroup) {
		const url = flatEntries[renderedCount]?.pageUrl || '';
		currentPageGroup = createPageGroupWrapper(url);
		listEl.appendChild(currentPageGroup);
	}

	for (let i = renderedCount; i < end; i++) {
		const unit = flatEntries[i];
		const { entries, pageUrl, domain, title } = unit;

		// Insert a page header when the URL changes (in all/domain views)
		if (currentNav.type !== 'page' && pageUrl !== lastPageUrl) {
			currentPageGroup = createPageGroupWrapper(pageUrl);
			listEl.appendChild(currentPageGroup);
			const pageHeader = createPageHeader(pageUrl, domain, title);
			currentPageGroup.appendChild(pageHeader);
			lastPageUrl = pageUrl;
		}

		(currentPageGroup || listEl).appendChild(createHighlightItem(entries, pageUrl));
	}

	renderedCount = end;
	createIcons({ icons });
}

function renderBreadcrumb() {
	const breadcrumbEl = document.getElementById('highlights-breadcrumb')!;
	breadcrumbEl.textContent = '';
	const nav = currentNav;

	if (nav.type === 'all') {
		const span = document.createElement('span');
		span.className = 'breadcrumb-current';
		span.textContent = getMessage('allHighlights');
		breadcrumbEl.appendChild(span);
		return;
	}

	// "All" link
	const allLink = document.createElement('a');
	allLink.className = 'breadcrumb-link';
	allLink.href = '#';
	allLink.textContent = getMessage('allHighlights');
	allLink.addEventListener('click', (e) => {
		e.preventDefault();
		navigate({ type: 'all' });
	});
	breadcrumbEl.appendChild(allLink);

	breadcrumbEl.appendChild(createBreadcrumbSeparator());

	if (nav.type === 'domain') {
		const span = document.createElement('span');
		span.className = 'breadcrumb-current';
		span.textContent = siteNameOrDomain(nav.domain);
		breadcrumbEl.appendChild(span);
	} else if (nav.type === 'page') {
		const domainSpan = document.createElement('span');
		domainSpan.className = 'breadcrumb-current';
		domainSpan.textContent = siteNameOrDomain(nav.domain);
		domainSpan.style.cursor = 'pointer';
		domainSpan.addEventListener('click', () => {
			navigate({ type: 'domain', domain: nav.domain });
		});
		breadcrumbEl.appendChild(domainSpan);
	}
}

function createBreadcrumbSeparator(): HTMLElement {
	const sep = document.createElement('span');
	sep.className = 'breadcrumb-separator';
	sep.textContent = '/';
	return sep;
}

function updateDeleteButton() {
	const deleteBtn = document.getElementById('delete-context-btn')!;

	deleteBtn.textContent = getMessage('delete');
}

async function deleteCurrentContext() {
	const nav = currentNav;
	if (nav.type === 'all') {
		if (!confirm(getMessage('deleteAllHighlightsConfirm'))) return;
		await browser.storage.local.set({ highlights: {} });
	} else if (nav.type === 'domain') {
		if (!confirm(getMessage('deleteHighlightsForDomain'))) return;
		const group = allDomainGroups.find(g => g.domain === nav.domain);
		if (group) await deleteHighlightsForDomain(group);
	} else if (nav.type === 'page') {
		if (!confirm(getMessage('deleteHighlightsForPage'))) return;
		await deleteHighlightsForUrl(nav.url);
	}
}

async function exportCurrentContext() {
	const entries = getVisibleEntries();
	if (entries.length === 0) return;

	// Group by URL to match the existing export format
	const byUrl = new Map<string, HighlightEntry[]>();
	for (const { entry, pageUrl } of entries) {
		if (!byUrl.has(pageUrl)) byUrl.set(pageUrl, []);
		byUrl.get(pageUrl)!.push(entry);
	}

	const exportData = Array.from(byUrl.entries()).map(([url, highlights]) => ({
		url,
		highlights: collapseGroupsForExport(highlights.map(h => h.data)),
	}));

	const jsonContent = JSON.stringify(exportData, null, 2);
	const blob = new Blob([jsonContent], { type: 'application/json' });
	const blobUrl = URL.createObjectURL(blob);

	const browserType = await detectBrowser();
	const timestamp = dayjs().format('YYYYMMDDHHmm');
	const fileName = `obsidian-web-clipper-highlights-${timestamp}.json`;

	if (browserType === 'safari' || browserType === 'mobile-safari') {
		if (navigator.share) {
			try {
				await navigator.share({
					files: [new File([blob], fileName, { type: 'application/json' })],
					title: 'Exported Obsidian Web Clipper Highlights',
				});
			} catch {
				window.open(blobUrl);
			}
		} else {
			window.open(blobUrl);
		}
	} else {
		const a = document.createElement('a');
		a.href = blobUrl;
		a.download = fileName;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
	}

	URL.revokeObjectURL(blobUrl);
}

function getLatestTimestamp(url: string): dayjs.Dayjs | null {
	const group = allDomainGroups.find(g => g.pages.some(p => p.url === url));
	const page = group?.pages.find(p => p.url === url);
	if (!page || page.highlights.length === 0) return null;
	let latest = 0;
	for (const h of page.highlights) {
		const t = parseInt(h.data.id);
		if (t > latest) latest = t;
	}
	const time = dayjs(latest);
	return time.isValid() ? time : null;
}

// --- Page headers in main content ---

function createPageHeader(url: string, domain: string, title?: string): HTMLElement {
	const header = document.createElement('div');
	header.className = 'highlight-page-header';

	const titleText = title || (() => {
		try {
			const parsed = new URL(url);
			return displayPath(parsed.pathname + parsed.search);
		} catch {
			return url;
		}
	})();

	const titleRow = document.createElement('div');
	titleRow.className = 'highlight-page-title-row';

	// Favicon makes each website's section read as a distinct heading in the
	// "all pages" view. Falls back to a globe icon when no favicon is stored.
	const normalizedDomain = domain.replace(/^www\./, '');
	const headerFavicon = domainSettingsMap[normalizedDomain]?.favicon;
	if (headerFavicon) {
		const img = document.createElement('img');
		img.className = 'highlight-page-favicon';
		img.src = headerFavicon;
		img.width = 18;
		img.height = 18;
		img.onerror = () => {
			const globe = document.createElement('i');
			globe.className = 'highlight-page-favicon';
			globe.setAttribute('data-lucide', 'globe');
			img.replaceWith(globe);
			createIcons({ icons });
		};
		titleRow.appendChild(img);
	} else {
		const globe = document.createElement('i');
		globe.className = 'highlight-page-favicon';
		globe.setAttribute('data-lucide', 'globe');
		titleRow.appendChild(globe);
	}

	const titleLink = document.createElement('a');
	titleLink.className = 'highlight-page-title';
	titleLink.href = '#';
	titleLink.title = url;
	titleLink.textContent = titleText;
	titleLink.addEventListener('click', (e) => {
		e.preventDefault();
		window.open(url, '_blank');
	});
	titleRow.appendChild(titleLink);

	const readerBtn = document.createElement('a');
	readerBtn.className = 'highlight-reader-btn clickable-icon';
	readerBtn.href = `reader.html?url=${encodeURIComponent(url)}`;
	readerBtn.target = '_blank';
	readerBtn.title = getMessage('loadArticle') || 'Read article';
	const readerIcon = document.createElement('i');
	readerIcon.setAttribute('data-lucide', 'book-open');
	readerBtn.appendChild(readerIcon);
	titleRow.appendChild(readerBtn);

	header.appendChild(titleRow);

	// Site name and latest timestamp
	const metaLine = document.createElement('div');
	metaLine.className = 'highlight-page-meta';

	const siteSpan = document.createElement('a');
	siteSpan.className = 'highlight-page-site';
	siteSpan.href = '#';
	siteSpan.textContent = siteNameOrDomain(domain);
	siteSpan.addEventListener('click', (e) => {
		e.preventDefault();
		navigate({ type: 'domain', domain });
	});
	metaLine.appendChild(siteSpan);

	const latestTime = getLatestTimestamp(url);
	if (latestTime) {
		const timeSpan = document.createElement('span');
		timeSpan.className = 'highlight-page-time';
		timeSpan.textContent = latestTime.fromNow();
		timeSpan.title = latestTime.format('YYYY-MM-DD HH:mm');
		metaLine.appendChild(timeSpan);
	}

	header.appendChild(metaLine);

	// Only show sync button if page has no title yet
	if (!title) {
		const syncBtn = document.createElement('button');
		syncBtn.className = 'highlight-sync-btn clickable-icon';
		const syncIcon = document.createElement('i');
		syncIcon.setAttribute('data-lucide', 'rotate-cw');
		syncBtn.appendChild(syncIcon);
		syncBtn.addEventListener('click', async (e) => {
			e.stopPropagation();
			e.preventDefault();
			syncBtn.classList.add('is-syncing');
			const meta = await fetchDefuddled(url);
			syncBtn.classList.remove('is-syncing');
			if (meta) {
				if (meta.title) titleLink.textContent = meta.title;
				if (meta.title || meta.site) syncBtn.style.display = 'none';
			}
		});
		header.appendChild(syncBtn);
	}

	return header;
}

interface DefuddleResult {
	title?: string;
	site?: string;
	content?: string;
}

async function fetchDefuddled(url: string): Promise<DefuddleResult | null> {
	try {
		let html: string;
		const fetchResult = await browser.runtime.sendMessage({
			action: 'fetchProxy', url, options: {},
		}) as { ok: boolean; status: number; text: string; error?: string };
		if (fetchResult?.error === 'CORS_PERMISSION_NEEDED') {
			await browser.permissions.request({ origins: ['<all_urls>'] });
			const retry = await browser.runtime.sendMessage({
				action: 'fetchProxy', url, options: {},
			}) as { ok: boolean; status: number; text: string; error?: string };
			if (!retry?.ok) throw new Error(retry?.error || 'Permission not granted');
			html = retry.text;
		} else if (!fetchResult?.ok) {
			throw new Error(fetchResult?.error || `HTTP ${fetchResult?.status}`);
		} else {
			html = fetchResult.text;
		}
		const parser = new DOMParser();
		const doc = parser.parseFromString(html, 'text/html');

		// Set the base URL so relative URLs resolve correctly
		const base = doc.createElement('base');
		base.href = url;
		doc.head.prepend(base);

		const defuddled = new Defuddle(doc, { url }).parse();

		const title = defuddled.title || undefined;
		const site = defuddled.site || undefined;
		const favicon = defuddled.favicon || undefined;
		const content = defuddled.content || undefined;

		// Save title to highlights storage
		if (title) {
			const result = await browser.storage.local.get('highlights');
			const allHighlights = (result.highlights || {}) as Record<string, StoredData>;
			if (allHighlights[url]) {
				allHighlights[url].title = title;
				await browser.storage.local.set({ highlights: allHighlights });
			}
		}

		// Save site and favicon to domains storage
		if (site || favicon) {
			let hostname: string;
			try {
				hostname = new URL(url).hostname.replace(/^www\./, '');
			} catch {
				return { title, site, content };
			}
			const domResult = await browser.storage.local.get('domains');
			const domains = (domResult.domains || {}) as Record<string, DomainSettings>;
			if (!domains[hostname]) domains[hostname] = {};
			let changed = false;
			if (site && !domains[hostname].site) {
				domains[hostname].site = site;
				changed = true;
			}
			if (favicon && !domains[hostname].favicon) {
				try {
					domains[hostname].favicon = new URL(favicon, url).href;
				} catch {
					domains[hostname].favicon = favicon;
				}
				changed = true;
			}
			if (changed) {
				domainSettingsMap[hostname] = domains[hostname];
				await browser.storage.local.set({ domains });
				renderSidebar();
				createIcons({ icons });
			}
		}

		return { title, site, content };
	} catch (error) {
		console.error('Failed to fetch page:', url, error);
		return null;
	}
}


// --- Individual highlight items ---

function setButtonIcon(btn: HTMLElement, iconName: string) {
	btn.textContent = '';
	const icon = document.createElement('i');
	icon.setAttribute('data-lucide', iconName);
	btn.appendChild(icon);
	createIcons({ icons });
}

function unitKey(entries: HighlightEntry[]): string {
	return entries.map(e => e.data.id).join(',');
}

// Make image highlights actually display: prefer the resolved anchor image src
// (captured at creation), else recover the real URL from data-src/srcset when the
// stored `src` is empty or a lazy-load placeholder. Also drop hotlink referers.
function fixHighlightImages(root: HTMLElement, entries: HighlightEntry[]): void {
	const imgs = Array.from(root.querySelectorAll('img'));
	if (!imgs.length) return;
	const anchorSrc = entries.map(e => e.data.anchor?.image?.src).find(Boolean);
	for (const img of imgs) {
		const src = img.getAttribute('src') || '';
		const dataSrc = img.getAttribute('data-src') || '';
		const srcset = img.getAttribute('srcset') || '';
		const isPlaceholder = !src || src.startsWith('data:');
		let resolved = anchorSrc || '';
		if (!resolved && isPlaceholder) resolved = dataSrc || srcset.split(',')[0]?.trim().split(/\s+/)[0] || '';
		if (resolved) img.setAttribute('src', resolved);
		img.setAttribute('referrerpolicy', 'no-referrer');
		img.removeAttribute('loading');
		img.removeAttribute('srcset');
	}
}

function createHighlightItem(entries: HighlightEntry[], pageUrl: string): HTMLElement {
	// Route video annotation entries to their dedicated card renderer.
	const carrier = entries[0]?.data as unknown as VideoCarrier;
	if (carrier?.__video) {
		return createVideoItemCard(carrier.__video, pageUrl, async (vid) => {
			await removeVideoItem(pageUrl, vid.id);
		});
	}

	const item = document.createElement('div');
	item.className = 'highlight-item';
	item.setAttribute('data-unit-key', unitKey(entries));
	// Surface the highlight's color so the list shows a color rail + tint
	// matching the live page. Grouped pieces share a color, so the first wins.
	item.setAttribute('data-color', entries[0]?.data.color || 'yellow');

	const content = document.createElement('div');
	content.className = 'highlight-item-content';

	const joined = entries.map(e => e.data.content || '').join('\n');
	content.replaceChildren(DOMPurify.sanitize(joined, { RETURN_DOM_FRAGMENT: true }));
	// A grouped selection may include stored <li> fragments; wrap consecutive
	// orphan <li>s in a <ul> so the list renders with its bullets intact.
	wrapOrphanListItems(content);
	// Image highlights store the raw <img> outerHTML, whose `src` is often a
	// lazy-load placeholder (real URL in data-src/srcset). Prefer the resolved
	// anchor image source captured at creation so the picture actually shows.
	fixHighlightImages(content, entries);
	if (searchQueryHighlights) highlightTextNodes(content, searchQueryHighlights);
	item.appendChild(content);

	const mergedNotes = entries.flatMap(e => e.data.notes ?? []);
	if (mergedNotes.length > 0) {
		const threadEl = document.createElement('div');
		threadEl.className = 'highlight-comment-thread';
		
		for (const note of mergedNotes) {
			const noteContainer = document.createElement('div');
			noteContainer.className = 'highlight-item-note-container';
			
			const timestampMatch = note.match(/<!--timestamp:(\d+)-->/);
			const editedMatch = note.match(/<!--edited:(\d+)-->/);
			let cleanNote = note
				.replace(/<!--timestamp:\d+-->/, '')
				.replace(/<!--edited:\d+-->/, '')
				.trim();
			
			if (timestampMatch) {
				const timestamp = parseInt(timestampMatch[1], 10);
				let timeStr = dayjs(timestamp).fromNow();
				if (editedMatch) {
					timeStr += ' (edited)';
				}
				
				const timeEl = document.createElement('div');
				timeEl.className = 'highlight-item-time';
				timeEl.textContent = timeStr;
				timeEl.style.marginBottom = '4px';
				noteContainer.appendChild(timeEl);
			}

			const noteEl = document.createElement('div');
			noteEl.className = 'highlight-item-note';
			noteEl.textContent = cleanNote;
			if (searchQueryHighlights) highlightTextNodes(noteEl, searchQueryHighlights);
			
			noteContainer.appendChild(noteEl);
			threadEl.appendChild(noteContainer);
		}
		item.appendChild(threadEl);
	}

	const footer = document.createElement('div');
	footer.className = 'highlight-item-actions-container';

	const actions = document.createElement('div');
	actions.className = 'highlight-item-actions';

	const copyBtn = document.createElement('button');
	copyBtn.className = 'highlight-action-btn clickable-icon';
	copyBtn.title = getMessage('copyToClipboard');
	const copyIcon = document.createElement('i');
	copyIcon.setAttribute('data-lucide', 'copy');
	copyBtn.appendChild(copyIcon);
	copyBtn.addEventListener('click', async () => {
		const markdown = entries.map(e => createMarkdownContent(e.data.content || '', pageUrl)).join('\n\n');
		await navigator.clipboard.writeText(markdown);
		copyBtn.classList.add('is-copied');
		setButtonIcon(copyBtn, 'check');
		setTimeout(() => {
			copyBtn.classList.remove('is-copied');
			setButtonIcon(copyBtn, 'copy');
		}, 1500);
	});
	actions.appendChild(copyBtn);

	const deleteBtn = document.createElement('button');
	deleteBtn.className = 'highlight-action-btn clickable-icon';
	deleteBtn.title = getMessage('delete');
	const deleteItemIcon = document.createElement('i');
	deleteItemIcon.setAttribute('data-lucide', 'trash-2');
	deleteBtn.appendChild(deleteItemIcon);
	deleteBtn.addEventListener('click', async () => {
		for (const e of entries) await deleteHighlight(pageUrl, e.data.id);
	});
	actions.appendChild(deleteBtn);

	footer.appendChild(actions);
	item.appendChild(footer);

	return item;
}

// Wrap consecutive orphan <li> elements (not already inside a <ul>/<ol>) in
// a <ul>. Used when rendering grouped highlights — stored <li> fragments
// don't carry their original list parent, so we synthesize one.
// TODO: always wraps in <ul>. Ordered list content (<ol>) loses its
// numbering. To fix, store the parent list type (ul vs ol) alongside each
// <li> highlight at creation time.
function wrapOrphanListItems(root: HTMLElement): void {
	const children = Array.from(root.children);
	let i = 0;
	while (i < children.length) {
		if (children[i].tagName === 'LI') {
			let j = i;
			while (j < children.length && children[j].tagName === 'LI') j++;
			const ul = document.createElement('ul');
			root.insertBefore(ul, children[i]);
			for (let k = i; k < j; k++) ul.appendChild(children[k]);
			i = j;
		} else {
			i++;
		}
	}
}

// --- Helpers ---

function highlightTextNodes(root: HTMLElement, query: string) {
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const matches: { node: Text; index: number; length: number }[] = [];
	const lowerQuery = query.toLowerCase();

	let node: Text | null;
	while ((node = walker.nextNode() as Text | null)) {
		const text = node.textContent || '';
		let idx = text.toLowerCase().indexOf(lowerQuery);
		while (idx !== -1) {
			matches.push({ node, index: idx, length: query.length });
			idx = text.toLowerCase().indexOf(lowerQuery, idx + query.length);
		}
	}

	// Process in reverse so indices stay valid
	for (let i = matches.length - 1; i >= 0; i--) {
		const { node: textNode, index, length } = matches[i];
		const after = textNode.splitText(index);
		const matched = after.splitText(length);
		const mark = document.createElement('mark');
		mark.className = 'search-match';
		mark.textContent = after.textContent;
		after.parentNode!.replaceChild(mark, after);
		// matched is already in the DOM after mark
		void matched;
	}
}

function displayDomain(domain: string): string {
	return domain.replace(/^www\./, '');
}

function siteNameOrDomain(domain: string): string {
	const normalized = domain.replace(/^www\./, '');
	return domainSettingsMap[normalized]?.site || normalized;
}

function displayPath(path: string): string {
	return decodeURIComponent(path).replace(/^\//, '');
}

// --- Storage mutations ---

async function deleteHighlight(url: string, highlightId: string) {
	const result = await browser.storage.local.get('highlights');
	const allHighlights = (result.highlights || {}) as Record<string, StoredData>;

	if (allHighlights[url]) {
		allHighlights[url].highlights = allHighlights[url].highlights.filter(h => h.id !== highlightId);
		if (allHighlights[url].highlights.length === 0) {
			delete allHighlights[url];
		}
		await browser.storage.local.set({ highlights: allHighlights });
	}
}

async function deleteHighlightsForUrl(url: string) {
	const result = await browser.storage.local.get('highlights');
	const allHighlights = (result.highlights || {}) as Record<string, StoredData>;
	delete allHighlights[url];
	await browser.storage.local.set({ highlights: allHighlights });
}

async function deleteHighlightsForDomain(group: DomainGroup) {
	const result = await browser.storage.local.get('highlights');
	const allHighlights = (result.highlights || {}) as Record<string, StoredData>;
	for (const page of group.pages) {
		delete allHighlights[page.url];
	}
	await browser.storage.local.set({ highlights: allHighlights });
}
