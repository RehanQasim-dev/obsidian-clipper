/**
 * Clipper Annotations — plugin entry / orchestrator.
 *
 * Ties together the four pieces:
 *   - {@link AnnotationStore}     persistence keyed by normalized source URL
 *   - {@link repaintHighlights}   reading-view painter (anchor → spans)
 *   - {@link SwatchPopup}         selection color-swatch popup
 *   - {@link CommentsView}        docked, linked comments panel
 *
 * It owns the "current source note" state, schedules repaints, and implements
 * the {@link CommentsController} the panel calls back into.
 */

import { debounce, MarkdownView, Modal, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { createAnchor, createImageAnchor, type RangeLike } from '../../shared/anchor';
import { pageFileName, type PageRecord, type Highlight } from '../../shared/merge';
import { AnnotationStore, normalizeUrl, type Annotation, type HighlightColor, type SourceAnnotations } from './store';
import { repaintHighlights, setActiveHighlight, scrollToHighlight, clearHighlights, type PaintResult } from './render';
import { SwatchPopup } from './swatch';
import { COMMENTS_VIEW_TYPE, CommentsView, type CommentsContext, type CommentsController } from './comments-view';
import { ClipperSettingTab, DEFAULT_SETTINGS, type ClipperAnnotationSettings } from './settings';
import { DriveClient, ConflictError, type AuthCodeRequest, type DriveAuthStore, type DriveTokens } from './drive';
import { reconcilePage } from './sync';

interface CurrentSource {
	file: TFile;
	url: string;
	title?: string;
	root: HTMLElement;
}

interface PendingSelection {
	range: RangeLike;
	root: HTMLElement;
	url: string;
	title?: string;
}

interface PendingImage {
	src: string;
	alt?: string;
	url: string;
	title?: string;
}

export default class ClipperAnnotationsPlugin extends Plugin {
	settings!: ClipperAnnotationSettings;
	private store!: AnnotationStore;
	private swatch!: SwatchPopup;

	// Drive sync state (persisted alongside the store in one data.json). Per-page:
	// one snapshot/foreign bucket per normalized URL, mirroring the per-page Drive layout.
	private driveTokens: DriveTokens | null = null;
	private syncSnapshots: Record<string, PageRecord> = {};
	private foreign: Record<string, Highlight[]> = {};

	private current: CurrentSource | null = null;
	private lastPaint: PaintResult | null = null;
	private pending: PendingSelection | null = null;
	private pendingImage: PendingImage | null = null;
	private repaintTimer: number | null = null;
	private syncing = false;
	// Watches the rendered preview so highlights paint the instant their text
	// renders — Obsidian renders reading view progressively and virtualizes
	// off-screen sections, so we can't rely on a single post-open repaint.
	private previewObserver: MutationObserver | null = null;
	private observedRoot: HTMLElement | null = null;
	private paintRaf: number | null = null;
	private syncPushDebouncer = debounce(() => void this.syncNow(false), 5000, true);

	async onload(): Promise<void> {
		const blob = ((await this.loadData()) as Record<string, unknown>) ?? {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, blob.settings as Partial<ClipperAnnotationSettings>);
		const drive = blob.drive as { tokens?: DriveTokens } | undefined;
		const sync = blob.sync as { snapshots?: Record<string, PageRecord>; foreign?: Record<string, Highlight[]> } | undefined;
		this.driveTokens = drive?.tokens ?? null;
		this.syncSnapshots = sync?.snapshots ?? {};
		this.foreign = sync?.foreign ?? {};

		this.store = new AnnotationStore(blob, () => this.persistAll());
		this.register(this.store.onChange(() => {
			this.scheduleRepaint(0);
			if (!this.syncing) {
				this.syncPushDebouncer();
			}
		}));

		this.swatch = new SwatchPopup(document, {
			onColor: (color) => this.commitHighlight(color, false),
			onComment: () => this.commitHighlight(this.settings.defaultColor, true),
		});
		this.register(() => this.swatch.destroy());

		this.registerView(COMMENTS_VIEW_TYPE, (leaf) => new CommentsView(leaf, this.controller()));

		this.addRibbonIcon('message-square', 'Clipper comments', () => this.activatePanel());
		this.addCommand({
			id: 'open-comments-panel',
			name: 'Open comments panel',
			callback: () => this.activatePanel(),
		});
		this.addCommand({
			id: 'highlight-selection',
			name: 'Highlight selection (default color)',
			checkCallback: (checking) => {
				const ok = !!this.selectionInSource();
				if (ok && !checking) this.commitHighlightFromSelection(this.settings.defaultColor, false);
				return ok;
			},
		});
		this.addCommand({ id: 'drive-sync-now', name: 'Sync with Google Drive', callback: () => this.syncNow(true) });
		this.addCommand({ id: 'drive-connect', name: 'Connect Google Drive', callback: () => this.connectDrive() });

		this.addSettingTab(new ClipperSettingTab(this.app, this));

		// Repaint triggers: post-render of any block, leaf changes, and layout settle.
		this.registerMarkdownPostProcessor((el) => {
			if (el.closest('.oc-comments')) return;
			this.scheduleRepaint();
		});
		this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleRepaint()));
		this.registerEvent(this.app.workspace.on('layout-change', () => this.scheduleRepaint()));
		this.app.workspace.onLayoutReady(() => this.scheduleRepaint());

		// Auto-sync with Drive so extension-made highlights show without a manual
		// pull: once on startup, on a light interval, and whenever the window
		// regains focus. All coalesced + non-interactive (never pops OAuth UI).
		this.app.workspace.onLayoutReady(() => void this.syncNow(false));
		this.registerInterval(window.setInterval(() => void this.syncNow(false), 60_000));
		this.registerDomEvent(window, 'focus', () => void this.syncNow(false));

		// Show the swatch when the user finishes a selection inside a clipped note.
		this.registerDomEvent(document, 'mouseup', () => window.setTimeout(() => this.onSelectionEnd(), 0));
		this.registerDomEvent(document, 'mousedown', (e) => {
			const t = e.target as HTMLElement;
			if (this.swatch.visible && !t.closest('.oc-swatch')) this.swatch.hide();
		});

		// Image annotations: click an image in the note to annotate it; hovering an
		// outlined image emphasizes its card. Capture phase so we win over Obsidian's
		// own image handling before creating/focusing.
		this.registerDomEvent(document, 'click', (e) => this.onImageClick(e), true);
		this.registerDomEvent(document, 'mouseover', (e) => this.onImageHover(e, true), true);
		this.registerDomEvent(document, 'mouseout', (e) => this.onImageHover(e, false), true);
	}

	onunload(): void {
		this.syncPreviewObserver(null);
		if (this.current) clearHighlights(this.current.root);
	}

	// --- settings + unified persistence ----------------------------------

	/** Single writer for data.json: store blob + settings + Drive tokens + sync state. */
	private async persistAll(): Promise<void> {
		await this.saveData({
			...this.store.raw(),
			settings: this.settings,
			drive: { tokens: this.driveTokens },
			sync: { snapshots: this.syncSnapshots, foreign: this.foreign },
		});
	}

	async saveSettings(): Promise<void> {
		await this.persistAll();
	}

	// --- Drive sync -------------------------------------------------------

	private driveAuth(): DriveAuthStore {
		return {
			getTokens: () => this.driveTokens,
			setTokens: async (t) => {
				this.driveTokens = t;
				await this.persistAll();
			},
		};
	}

	private driveClient(): DriveClient {
		return new DriveClient(this.settings.driveClientId, this.settings.driveClientSecret, this.driveAuth());
	}

	driveConnected(): boolean {
		return this.driveClient().isConnected();
	}

	async connectDrive(): Promise<void> {
		const drive = this.driveClient();
		if (!drive.isConfigured()) {
			new Notice('Add your Google OAuth client id in settings first.');
			return;
		}
		try {
			const req = await drive.requestAuthCode();
			const modal = new AuthCodeModal(this.app, req.authUrl, async (code) => {
				try {
					await drive.exchangeCode(code, req.codeVerifier);
					new Notice('Connected to Google Drive.');
					await this.syncNow(true);
				} catch (err) {
					new Notice(`Drive connect failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			});
			modal.open();
		} catch (err) {
			new Notice(`Drive connect failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	async disconnectDrive(): Promise<void> {
		await this.driveClient().disconnect();
		new Notice('Disconnected from Google Drive.');
	}

	async syncNow(interactive = false): Promise<void> {
		const drive = this.driveClient();
		if (!drive.isConfigured() || !drive.isConnected()) {
			if (interactive) new Notice('Connect Google Drive first (Settings → Clipper Annotations).');
			return;
		}
		if (this.syncing) return; // coalesce overlapping interval/focus/manual triggers
		this.syncing = true;
		try {
			const byUrl = new Map<string, SourceAnnotations>();
			for (const s of this.store.allSources()) byUrl.set(normalizeUrl(s.url), s);

			// Candidate pages: local annotations + preserved foreign + prior snapshots…
			const urls = new Set<string>([...byUrl.keys(), ...Object.keys(this.foreign), ...Object.keys(this.syncSnapshots)]);
			// …plus remote-only pages (filename is a hash, so download to learn the url).
			const remoteFiles = await drive.listPages();
			const localNames = new Set<string>();
			for (const u of urls) localNames.add(await pageFileName(u));
			for (const f of remoteFiles) {
				if (!localNames.has(f.name)) {
					const rec = await drive.getPageById(f.id);
					if (rec?.url) urls.add(normalizeUrl(rec.url));
				}
			}

			// Reconcile each page independently (per-page compare-and-swap).
			const nextSources: SourceAnnotations[] = [];
			for (const url of urls) {
				const name = await pageFileName(url);
				for (let attempt = 0; attempt < 4; attempt++) {
					const { record: remote, fileId, revision } = await drive.pullPage(name);
					const src = byUrl.get(url);
					const out = reconcilePage({
						url,
						title: src?.title,
						snapshot: this.syncSnapshots[url] ?? null,
						remote,
						annotations: src?.annotations ?? [],
						foreign: this.foreign[url] ?? [],
						now: Date.now(),
					});
					try {
						if (JSON.stringify(out.merged) !== JSON.stringify(remote)) {
							await drive.pushPage(name, out.merged, fileId, revision);
						}
					} catch (err) {
						if (err instanceof ConflictError && attempt < 3) continue; // remote moved — redo this page
						throw err;
					}
					this.syncSnapshots[url] = out.merged;
					if (out.foreign.length) this.foreign[url] = out.foreign; else delete this.foreign[url];
					if (out.annotations.length) nextSources.push({ url, ...(out.title ? { title: out.title } : {}), annotations: out.annotations });
					break;
				}
			}

			await this.store.replaceAll(nextSources); // persists store + sync state via persistAll
			this.repaint();
			if (interactive) new Notice('Synced with Google Drive.');
		} catch (err) {
			if (interactive) new Notice(`Sync failed: ${err instanceof Error ? err.message : String(err)}`);
		} finally {
			this.syncing = false;
		}
	}

	// --- current source detection ----------------------------------------

	private sourceUrlFor(file: TFile): string | null {
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
		if (!fm) return null;
		const keys = this.settings.sourceKeys.split(',').map((k) => k.trim()).filter(Boolean);
		for (const k of keys) {
			const v = fm[k];
			if (typeof v === 'string' && /^https?:\/\//i.test(v)) return normalizeUrl(v);
		}
		return null;
	}

	private activeReadingView(): { view: MarkdownView; root: HTMLElement } | null {
		const file = this.app.workspace.getActiveFile();
		if (!file) return null;
		const leaves = this.app.workspace.getLeavesOfType('markdown');
		const leaf = leaves.find((l) => (l.view as MarkdownView).file === file);
		const view = leaf?.view as MarkdownView | undefined;
		if (!view || view.getMode() !== 'preview') return null;
		const root = view.contentEl.querySelector<HTMLElement>('.markdown-preview-view');
		return root ? { view, root } : null;
	}

	private refreshCurrent(): void {
		const rv = this.activeReadingView();
		if (!rv || !(rv.view.file instanceof TFile)) {
			this.current = null;
			this.syncPreviewObserver(null);
			return;
		}
		const url = this.sourceUrlFor(rv.view.file);
		if (!url) {
			this.current = null;
			this.syncPreviewObserver(null);
			return;
		}
		const title = this.app.metadataCache.getFileCache(rv.view.file)?.frontmatter?.title ?? rv.view.file.basename;
		this.current = { file: rv.view.file, url, title, root: rv.root };
		this.syncPreviewObserver(rv.root);
	}

	// --- repaint ----------------------------------------------------------

	private scheduleRepaint(delay = 120): void {
		if (this.repaintTimer != null) window.clearTimeout(this.repaintTimer);
		this.repaintTimer = window.setTimeout(() => {
			this.repaintTimer = null;
			this.repaint();
		}, delay);
	}

	/** Full refresh: re-detect the note, repaint highlights, and rebuild the panel. */
	private repaint(): void {
		this.refreshCurrent();
		if (!this.current) {
			this.lastPaint = null;
			this.view()?.refresh();
			return;
		}
		this.paintCurrent();
		const anns = this.store.for(this.current.url);
		if (this.settings.autoOpenPanel && anns.length) void this.activatePanel(false);
		this.view()?.refresh();
	}

	/** Repaint just the highlights for the current note (no panel rebuild). */
	private paintCurrent(): void {
		if (!this.current) return;
		const root = this.current.root;
		const anns = this.store.for(this.current.url);
		// Pause the observer so our own span wrapping doesn't re-trigger a paint.
		this.previewObserver?.disconnect();
		try {
			this.lastPaint = repaintHighlights(root, anns, {
				onHover: (id) => {
					setActiveHighlight(this.current!.root, id);
					this.view()?.setActive(id);
				},
				onActivate: (id) => {
					void this.activatePanel().then(() => this.view()?.focusAnnotation(id));
				},
			}, this.current.url);
		} finally {
			if (this.previewObserver && this.observedRoot === root) {
				this.previewObserver.observe(root, { childList: true, subtree: true, characterData: true });
			}
		}
	}

	/** Point the preview observer at `root` (or tear it down when `root` is null). */
	private syncPreviewObserver(root: HTMLElement | null): void {
		if (root === this.observedRoot) return;
		this.previewObserver?.disconnect();
		if (this.paintRaf != null) {
			window.cancelAnimationFrame(this.paintRaf);
			this.paintRaf = null;
		}
		this.observedRoot = root;
		if (!root) {
			this.previewObserver = null;
			return;
		}
		this.previewObserver = new MutationObserver(() => this.schedulePaint());
		this.previewObserver.observe(root, { childList: true, subtree: true, characterData: true });
	}

	/** Coalesce observer bursts (initial render, scroll virtualization) into one paint per frame. */
	private schedulePaint(): void {
		if (this.paintRaf != null) return;
		this.paintRaf = window.requestAnimationFrame(() => {
			this.paintRaf = null;
			this.refreshCurrent();
			this.paintCurrent();
		});
	}

	// --- selection → swatch ----------------------------------------------

	private selectionInSource(): { range: RangeLike; root: HTMLElement; url: string; title?: string } | null {
		this.refreshCurrent();
		if (!this.current) return null;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
		const range = sel.getRangeAt(0);
		if (!this.current.root.contains(range.commonAncestorContainer)) return null;
		if (!range.toString().trim()) return null;
		return { range, root: this.current.root, url: this.current.url, title: this.current.title };
	}

	private onSelectionEnd(): void {
		const sel = this.selectionInSource();
		if (!sel) {
			// An image was just clicked (this runs on the mouseup that precedes the
			// click) — keep the swatch the click is about to open.
			if (this.pendingImage) return;
			if (this.swatch.visible) this.swatch.hide();
			return;
		}
		this.pendingImage = null;
		this.pending = sel;
		const rect = (sel.range as Range).getBoundingClientRect();
		this.swatch.showFor(rect);
	}

	private commitHighlight(color: HighlightColor, openComment: boolean): void {
		if (this.pendingImage) {
			const pi = this.pendingImage;
			this.pendingImage = null;
			void this.createImage(pi, color, openComment);
			return;
		}
		if (!this.pending) return;
		void this.create(this.pending, color, openComment);
	}

	/** Create an image annotation (click an image in the note → swatch → color). */
	private async createImage(pi: PendingImage, color: HighlightColor, openComment: boolean): Promise<void> {
		this.swatch.hide();
		const anchor = createImageAnchor(pi.src, pi.alt);
		const ann = await this.store.addImageHighlight(pi.url, anchor, color, Date.now(), pi.title);
		this.repaint();
		if (openComment) {
			await this.activatePanel();
			this.view()?.focusAnnotation(ann.id);
		}
	}

	// Click an image in the reading view: focus its card if already annotated,
	// otherwise open the color swatch to create a new image annotation.
	private onImageClick(e: MouseEvent): void {
		const target = e.target as HTMLElement | null;
		const img = target?.closest?.('img') as HTMLImageElement | null;
		if (!img) return; // cheap early-out before re-detecting the source note
		this.refreshCurrent();
		if (!this.current || !this.current.root.contains(img)) return;

		const existingId = img.dataset.annId;
		if (existingId) {
			e.preventDefault();
			e.stopPropagation();
			void this.activatePanel().then(() => this.view()?.focusAnnotation(existingId));
			return;
		}
		const src = img.currentSrc || img.src || img.getAttribute('src') || '';
		if (!src) return;
		e.preventDefault();
		e.stopPropagation();
		this.pending = null;
		const alt = img.getAttribute('alt') || undefined;
		this.pendingImage = { src, alt, url: this.current.url, title: this.current.title };
		this.swatch.showFor(img.getBoundingClientRect());
	}

	// Hovering an outlined image emphasizes its card (mirrors text-span hover).
	private onImageHover(e: MouseEvent, on: boolean): void {
		if (!this.current) return;
		const img = (e.target as HTMLElement | null)?.closest?.('.oc-img-hl') as HTMLElement | null;
		if (!img || !this.current.root.contains(img)) return;
		this.view()?.setActive(on ? img.dataset.annId ?? null : null);
	}

	private commitHighlightFromSelection(color: HighlightColor, openComment: boolean): void {
		const sel = this.selectionInSource();
		if (sel) void this.create(sel, color, openComment);
	}

	private async create(sel: PendingSelection, color: HighlightColor, openComment: boolean): Promise<void> {
		const anchor = createAnchor(sel.range, sel.root, 'obsidian');
		this.swatch.hide();
		window.getSelection()?.removeAllRanges();
		this.pending = null;
		if (!anchor) return;
		const ann = await this.store.addHighlight(sel.url, anchor, color, Date.now(), sel.title);
		this.repaint();
		if (openComment) {
			await this.activatePanel();
			this.view()?.focusAnnotation(ann.id);
		}
	}

	// --- comments panel ---------------------------------------------------

	private view(): CommentsView | null {
		const leaf = this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0];
		return (leaf?.view as CommentsView) ?? null;
	}

	private async activatePanel(reveal = true): Promise<void> {
		let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(COMMENTS_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false);
			if (leaf) await leaf.setViewState({ type: COMMENTS_VIEW_TYPE, active: false });
		}
		if (leaf && reveal) this.app.workspace.revealLeaf(leaf);
	}

	private controller(): CommentsController {
		return {
			getContext: (): CommentsContext | null => {
				if (!this.current) return null;
				const all = this.store.for(this.current.url);
				return { url: this.current.url, title: this.current.title, annotations: all, unplaced: [] };
			},
			addComment: async (id, text) => {
				if (this.current) await this.store.addComment(this.current.url, id, text, Date.now());
			},
			setColor: async (id, color) => {
				if (this.current) await this.store.setColor(this.current.url, id, color, Date.now());
			},
			deleteAnnotation: async (id) => {
				if (this.current) await this.store.deleteAnnotation(this.current.url, id);
			},
			emphasizeInSource: (id) => {
				if (this.current) setActiveHighlight(this.current.root, id);
			},
			revealInSource: (id) => {
				if (!this.current) return;
				const escapedId = id.replace(/["\\]/g, '\\$&');
				const el = this.current.root.querySelector(
					`span.oc-hl[data-ann-id="${escapedId}"], .oc-img-hl[data-ann-id="${escapedId}"]`,
				);
				if (el) {
					el.scrollIntoView({ behavior: 'smooth', block: 'center' });
					return;
				}
				// If virtualized off-screen, scroll to the corresponding line.
				const ann = this.store.for(this.current.url).find((a) => a.id === id);
				if (!ann || !ann.anchor.quote.quote) return;
				
				this.app.vault.cachedRead(this.current.file).then((content) => {
					let idx = content.indexOf(ann.anchor.quote.quote);
					if (idx === -1) idx = content.indexOf(ann.anchor.quote.quote.substring(0, 15));
					
					if (idx !== -1) {
						const line = content.substring(0, idx).split('\n').length - 1;
						const leaves = this.app.workspace.getLeavesOfType('markdown');
						const leaf = leaves.find((l) => (l.view as import('obsidian').MarkdownView).file === this.current!.file);
						if (leaf) leaf.setEphemeralState({ line });
					}
				});
			},
		};
	}
}

/** Asks the user to paste the redirect URL or auth code. */
class AuthCodeModal extends Modal {
	private authUrl: string;
	private onSubmit: (code: string) => void;

	constructor(app: import('obsidian').App, authUrl: string, onSubmit: (code: string) => void) {
		super(app);
		this.authUrl = authUrl;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Connect Google Drive' });
		
		const p1 = contentEl.createEl('p', { text: '1. Open this authorization link in your browser:' });
		p1.style.marginBottom = '4px';
		const link = contentEl.createEl('a', { text: 'Click here to authorize with Google', href: this.authUrl, attr: { target: '_blank' } });
		link.style.display = 'block';
		link.style.marginBottom = '16px';

		const p2 = contentEl.createEl('p', { text: '2. After you approve, your browser will redirect to a page that says "Site can\'t be reached" (127.0.0.1). That is normal!' });
		p2.style.marginBottom = '8px';

		const p3 = contentEl.createEl('p', { text: '3. Copy the ENTIRE URL from your browser\'s address bar and paste it below:' });
		p3.style.marginBottom = '8px';

		const input = contentEl.createEl('input', { type: 'text', placeholder: 'http://127.0.0.1/?code=4/0A...' });
		input.style.width = '100%';
		input.style.marginBottom = '16px';

		const btn = contentEl.createEl('button', { text: 'Connect', cls: 'mod-cta' });
		btn.onclick = () => {
			const val = input.value.trim();
			let code = val;
			try {
				if (val.startsWith('http')) {
					const url = new URL(val);
					code = url.searchParams.get('code') || val;
				}
			} catch { /* ignore */ }
			
			if (!code) return;
			this.onSubmit(code);
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// Re-export so esbuild keeps the symbol referenced from the view module.
export type { Annotation };
