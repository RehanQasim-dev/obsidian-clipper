// Pure serializers: annotation data → Markdown for Obsidian. No I/O here.
//
// Design:
//   - Each annotation is a semantic callout (clip-hl / clip-img / clip-frame /
//     clip-transcript / clip-note) carrying its highlight color as callout
//     metadata (`> [!clip-hl|red]`). Comments are a nested `clip-reply` callout.
//   - The look is entirely CSS-driven (CLIP_CSS, pushed to the vault). The note's
//     frontmatter `cssclasses: [clip, clip-<theme>]` selects the theme, so the same
//     body renders as either "cards" (cards + side-by-side media) or "document"
//     (minimal typographic) — switching theme + re-syncing is enough.
//   - Body uses real Markdown (callouts, embeds, <mark>) so Obsidian features keep
//     working — no raw HTML wrappers that would disable markdown/embeds.
//   - Generated content lives in a managed region so re-syncs never clobber the
//     user's own edits elsewhere in the note.

export const REGION_START = '%% clipper:start — do not edit inside this block %%';
export const REGION_END = '%% clipper:end %%';

export type ClipTheme = 'cards' | 'document';

interface NoteParts {
	text: string;
	timestamp?: number;
}
interface HighlightLike {
	id: string;
	content: string;
	notes?: string[];
	color?: string;
	groupId?: string;
}
interface VideoItemLike {
	id: string;
	kind: 'frame' | 'note' | 'transcript';
	videoTime: number;
	timeEnd?: number;
	quote?: string;
	color?: string;
	notes?: string[];
	frame?: { dataUrl?: string; w?: number; h?: number };
}

// Max display width (px) for embedded images (YouTube frames and live-page image
// annotations), so Obsidian doesn't stretch them to the full (wider) note column.
const IMAGE_DISPLAY_WIDTH = 480;

// Element highlights store the element's raw outerHTML. For image elements we pull
// out the src so we can embed a width-capped image instead of dumping the <img>.
function extractImageSrc(html: string, pageUrl: string): { src: string; alt: string } | null {
	if (!/<img[\s>]/i.test(html)) return null;
	const srcMatch =
		html.match(/<img[^>]*\ssrc=["']([^"']+)["']/i) ||
		html.match(/<img[^>]*\sdata-src=["']([^"']+)["']/i) ||
		html.match(/<img[^>]*\ssrcset=["']([^"',\s]+)/i);
	if (!srcMatch) return null;
	let src = srcMatch[1].trim();
	try {
		src = new URL(src, pageUrl).href; // resolve relative / protocol-relative URLs
	} catch {
		/* leave as-is */
	}
	const altMatch = html.match(/<img[^>]*\salt=["']([^"']*)["']/i);
	return { src, alt: altMatch ? altMatch[1] : '' };
}

function parseNote(note: string): NoteParts {
	const ts = note.match(/<!--timestamp:(\d+)-->/);
	const text = note
		.replace(/<!--timestamp:\d+-->/, '')
		.replace(/<!--edited:\d+-->/, '')
		.trim();
	return { text, timestamp: ts ? parseInt(ts[1], 10) : undefined };
}

function colorClass(color?: string): string {
	return `hl-${color || 'yellow'}`;
}

function mark(content: string, color?: string): string {
	const oneLine = content.replace(/\s*\n\s*/g, ' ').trim();
	return `<mark class="${colorClass(color)}">${oneLine}</mark>`;
}

function fmtDate(ts?: number): string {
	if (!ts) return '';
	const d = new Date(ts);
	return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function mmss(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function timeLink(url: string, seconds: number, label: string): string {
	const sep = url.includes('?') ? '&' : '?';
	return `[${label}](${url}${sep}t=${Math.floor(seconds)}s)`;
}

// Comments → a nested `clip-reply` callout under the annotation. `prefix` lets the
// caller place it at the right nesting depth (e.g. '> ' to nest one level).
function commentsCallout(notes: string[] | undefined, prefix: string): string {
	const items = (notes || []).map(parseNote).filter(n => n.text);
	if (!items.length) return '';
	const lines = [`${prefix}> [!clip-reply]- Comments`];
	for (const c of items) {
		const date = fmtDate(c.timestamp);
		lines.push(`${prefix}> ${date ? `*${date}* — ` : ''}${c.text.replace(/\n/g, ' ')}`);
	}
	return lines.join('\n');
}

// Assemble one annotation node as a callout (+ optional nested comments).
function calloutNode(
	type: string,
	color: string | undefined,
	title: string,
	bodyLines: string[],
	notes: string[] | undefined,
): string {
	const meta = color ? `|${color}` : '';
	const lines = [`> [!${type}${meta}] ${title}`];
	for (const b of bodyLines) lines.push(`> ${b}`);
	const comments = commentsCallout(notes, '> ');
	if (comments) lines.push('>', comments);
	return lines.join('\n');
}

// --- Web-page highlights -----------------------------------------------------

// Collapse multi-block highlights (shared groupId) into one node.
function groupHighlights(highlights: HighlightLike[]): HighlightLike[] {
	const out: HighlightLike[] = [];
	const byGroup = new Map<string, HighlightLike>();
	for (const h of highlights) {
		if (!h.groupId) {
			out.push(h);
			continue;
		}
		const existing = byGroup.get(h.groupId);
		if (existing) {
			existing.content = `${existing.content} ${h.content}`.trim();
			existing.notes = [...(existing.notes || []), ...(h.notes || [])];
		} else {
			const clone = { ...h, notes: [...(h.notes || [])] };
			byGroup.set(h.groupId, clone);
			out.push(clone);
		}
	}
	return out;
}

export function buildPageBlock(title: string, url: string, highlights: HighlightLike[]): string {
	const nodes: string[] = [];
	for (const h of groupHighlights(highlights)) {
		const img = extractImageSrc(h.content, url);
		if (img) {
			nodes.push(calloutNode('clip-img', h.color, 'Image', [`![${img.alt}|${IMAGE_DISPLAY_WIDTH}](${img.src})`], h.notes));
		} else {
			nodes.push(calloutNode('clip-hl', h.color, 'Highlight', [mark(h.content, h.color)], h.notes));
		}
	}
	return [`[Open original ↗](${url})`, '', nodes.join('\n\n')].join('\n');
}

// --- YouTube video annotations ----------------------------------------------

export interface VideoBlockResult {
	markdown: string;
	attachments: { filename: string; dataUrl: string }[];
}

export function buildVideoBlock(
	title: string,
	url: string,
	videoId: string,
	items: VideoItemLike[],
): VideoBlockResult {
	const attachments: { filename: string; dataUrl: string }[] = [];
	const sorted = [...items].sort((a, b) => a.videoTime - b.videoTime);
	const nodes: string[] = [];

	for (const it of sorted) {
		if (it.kind === 'transcript') {
			const range = it.timeEnd != null ? `${mmss(it.videoTime)}–${mmss(it.timeEnd)}` : mmss(it.videoTime);
			nodes.push(calloutNode(
				'clip-transcript',
				it.color,
				`Transcript · ${timeLink(url, it.videoTime, range)}`,
				it.quote ? [mark(it.quote, it.color)] : [],
				it.notes,
			));
		} else if (it.kind === 'frame') {
			const body: string[] = [];
			if (it.frame?.dataUrl) {
				const filename = `youtube-${videoId}-${it.id}.jpg`;
				attachments.push({ filename, dataUrl: it.frame.dataUrl });
				const width = Math.min(it.frame.w || IMAGE_DISPLAY_WIDTH, IMAGE_DISPLAY_WIDTH);
				body.push(`![[${filename}|${width}]]`);
			}
			nodes.push(calloutNode('clip-frame', it.color, `Frame · ${timeLink(url, it.videoTime, mmss(it.videoTime))}`, body, it.notes));
		} else {
			nodes.push(calloutNode('clip-note', it.color, `Note · ${timeLink(url, it.videoTime, mmss(it.videoTime))}`, [], it.notes));
		}
	}

	const markdown = [`[Watch on YouTube ↗](${url})`, '', nodes.join('\n\n')].join('\n');
	return { markdown, attachments };
}

// --- Managed region assembly -------------------------------------------------

function cssClassesLine(theme: ClipTheme): string {
	return `cssclasses: ["clip", "clip-${theme}"]`;
}

function buildFrontmatter(props: Record<string, string>, theme: ClipTheme): string {
	const lines = ['---', cssClassesLine(theme)];
	for (const [k, v] of Object.entries(props)) lines.push(`${k}: ${JSON.stringify(v)}`);
	lines.push('---');
	return lines.join('\n');
}

// Ensure existing frontmatter carries the current theme's cssclasses.
function withCssClasses(existing: string, theme: ClipTheme): string {
	const line = cssClassesLine(theme);
	if (existing.startsWith('---')) {
		const end = existing.indexOf('\n---', 3);
		if (end !== -1) {
			let fm = existing.slice(0, end);
			const rest = existing.slice(end);
			fm = /^cssclasses:.*$/m.test(fm) ? fm.replace(/^cssclasses:.*$/m, line) : `${fm}\n${line}`;
			return fm + rest;
		}
	}
	return `---\n${line}\n---\n\n${existing}`;
}

/**
 * Produce the final note contents. If `existing` already contains our managed
 * region we swap just that region (preserving the user's own edits) and refresh
 * the theme cssclasses; otherwise we create the file with frontmatter + region.
 */
export function assembleNote(
	existing: string | null,
	block: string,
	props: Record<string, string>,
	theme: ClipTheme,
	sourceBody?: string,
): string {
	const region = `${REGION_START}\n${block}\n${REGION_END}`;
	if (existing) {
		const withCss = withCssClasses(existing, theme);
		const startIdx = withCss.indexOf(REGION_START);
		const endIdx = withCss.indexOf(REGION_END);
		if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
			return withCss.slice(0, startIdx) + region + withCss.slice(endIdx + REGION_END.length);
		}
		return `${withCss.trimEnd()}\n\n${region}\n`;
	}
	// First write: the managed region sits at the top so annotations are
	// immediately visible; the immutable page source (if captured) follows below
	// the region and is never rewritten on later syncs. Both live outside the
	// region so the source body is preserved across re-syncs.
	const parts = [buildFrontmatter(props, theme), '', region];
	if (sourceBody && sourceBody.trim()) {
		parts.push('', SOURCE_HEADING, '', sourceBody.trim());
	}
	return parts.join('\n') + '\n';
}

// Heading that introduces the captured page source body in a new note.
export const SOURCE_HEADING = '## Source';

/**
 * Assemble the **source note** — the immutable page text the Obsidian plugin
 * renders and anchors highlights against. It carries NO annotation callouts
 * (those live in the separate comments note); just frontmatter + the captured
 * body. Written once: if the note already exists we leave the body untouched and
 * only refresh the theme cssclasses, so re-syncs never rewrite the source.
 */
export function assembleSourceNote(
	existing: string | null,
	props: Record<string, string>,
	theme: ClipTheme,
	sourceBody?: string,
): string {
	if (existing) return withCssClasses(existing, theme);
	const parts = [buildFrontmatter(props, theme)];
	if (sourceBody && sourceBody.trim()) {
		parts.push('', SOURCE_HEADING, '', sourceBody.trim());
	}
	return parts.join('\n') + '\n';
}

/**
 * Assemble the **comments note** — a human-readable mirror of the annotations
 * for a page, in its own file (two files per URL: source + comments). The
 * annotation callouts live in a managed region so the user's own edits elsewhere
 * survive re-syncs; the region is fully regenerated on every sync. The
 * frontmatter deliberately omits any `source`/`url` key so the plugin does NOT
 * treat this file as a source note — navigation is a body wikilink instead.
 */
export function assembleCommentsNote(
	existing: string | null,
	title: string,
	url: string,
	sourceNoteName: string,
	block: string,
	props: Record<string, string>,
	theme: ClipTheme,
): string {
	const header = [
		`# Comments — ${title}`,
		'',
		`Source note: [[${sourceNoteName}]] · [Open original ↗](${url})`,
		'',
		block,
	].join('\n');
	return assembleNote(existing, header, props, theme);
}

// --- The vault CSS snippet (both themes) -------------------------------------
// Bump CLIP_CSS_VERSION whenever CLIP_CSS changes so it re-pushes on next sync.

export const CLIP_CSS_VERSION = 3;

export const CLIP_CSS = `/* Obsidian Web Clipper — annotation styles.
   Auto-generated. Enable under Settings → Appearance → CSS snippets. */
:root {
  --clip-yellow: 232, 197, 71;
  --clip-red: 232, 113, 113;
  --clip-green: 124, 193, 124;
}

/* Highlight marks (both themes) */
mark.hl-yellow { background: rgb(var(--clip-yellow)); color: #000; border-radius: 3px; padding: 0 .15em; }
mark.hl-red { background: rgb(var(--clip-red)); color: #000; border-radius: 3px; padding: 0 .15em; }
mark.hl-green { background: rgb(var(--clip-green)); color: #000; border-radius: 3px; padding: 0 .15em; }

/* Source link line */
.clip .markdown-preview-section a[href^="http"]:first-child { font-family: var(--font-monospace); font-size: .8em; color: var(--text-faint); }

/* Per-node accent from callout metadata color */
.clip .callout[data-callout^="clip-"] { --clip-acc: var(--background-modifier-border); }
.clip .callout[data-callout^="clip-"][data-callout-metadata="yellow"] { --clip-acc: rgb(var(--clip-yellow)); }
.clip .callout[data-callout^="clip-"][data-callout-metadata="red"] { --clip-acc: rgb(var(--clip-red)); }
.clip .callout[data-callout^="clip-"][data-callout-metadata="green"] { --clip-acc: rgb(var(--clip-green)); }

/* Mono, muted, uppercase titles; hide default callout icons */
.clip .callout[data-callout^="clip-"] > .callout-title {
  font-family: var(--font-monospace); font-size: .72em; letter-spacing: .06em;
  text-transform: uppercase; color: var(--text-muted); font-weight: 600;
}
.clip .callout[data-callout^="clip-"] > .callout-title .callout-icon { display: none; }
.clip .callout[data-callout^="clip-"] > .callout-title a { color: var(--text-muted); }

/* Comments (reply) — quiet thread in both themes */
.clip .callout[data-callout="clip-reply"] { background: transparent; border: 0; margin: .4em 0 0; padding: .1em 0 0; mix-blend-mode: normal; }
.clip .callout[data-callout="clip-reply"] > .callout-content p { color: var(--text-muted); font-size: .92em; line-height: 1.45; margin: .15em 0; }
.clip .callout[data-callout="clip-reply"] > .callout-content p::before { content: "› "; color: var(--text-faint); }

/* Images */
.clip .callout img { border-radius: 8px; max-width: 100%; height: auto; }

/* ============ CARDS theme ============ */
.clip-cards .callout[data-callout^="clip-"]:not([data-callout="clip-reply"]) {
  background: var(--background-primary-alt);
  border: 1px solid var(--background-modifier-border);
  border-left: 3px solid var(--clip-acc);
  border-radius: 10px;
  padding: .6em .9em;
  margin: .85em 0;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .04);
}
/* Side-by-side: media left, comments right for frames & image highlights */
.clip-cards .callout[data-callout="clip-frame"] > .callout-content,
.clip-cards .callout[data-callout="clip-img"] > .callout-content {
  display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap;
}
.clip-cards .callout[data-callout="clip-frame"] > .callout-content > p:first-child,
.clip-cards .callout[data-callout="clip-img"] > .callout-content > p:first-child { flex: 0 0 auto; margin: 0; }
.clip-cards .callout[data-callout="clip-frame"] > .callout-content > .callout,
.clip-cards .callout[data-callout="clip-img"] > .callout-content > .callout { flex: 1 1 220px; }

/* ============ DOCUMENT theme ============ */
.clip-document .callout[data-callout^="clip-"]:not([data-callout="clip-reply"]) {
  background: transparent; border: 0; border-left: 2px solid var(--clip-acc);
  border-radius: 0; padding: .1em 0 .2em .85em; margin: 1.1em 0; box-shadow: none;
}
.clip-document .callout[data-callout^="clip-"] > .callout-content { font-size: 1.02em; }
.clip-document .callout img { display: block; margin: .45em 0; border-radius: 6px; }
`;
