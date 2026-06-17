// Pure serializers: annotation data → Markdown for Obsidian. No I/O here.
//
// Conventions:
//   - Highlight colors are preserved with inline <mark class="hl-…"> spans (a CSS
//     snippet maps the classes to colors; see obsidian-sync.pushCssSnippet).
//   - Each annotation ("node") is separated by a `---` rule.
//   - Comments live inline in notes[] as "text<!--timestamp:N--><!--edited:M-->".
//   - Our generated content is wrapped in a managed region so re-syncs never clobber
//     the user's own edits elsewhere in the note.

export const REGION_START = '%% clipper:start — do not edit inside this block %%';
export const REGION_END = '%% clipper:end %%';

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
	// Keep highlighted text on one line so the <mark> renders cleanly in callouts.
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

// Render a comment thread as a nested callout under its annotation. `>` prefix is
// applied by the caller so this can nest at any depth.
function commentsCallout(notes: string[] | undefined, prefix: string): string {
	const items = (notes || []).map(parseNote).filter(n => n.text);
	if (!items.length) return '';
	const lines = [`${prefix}> [!note]- Comments`];
	for (const c of items) {
		const date = fmtDate(c.timestamp);
		lines.push(`${prefix}> ${date ? `*${date}* — ` : ''}${c.text.replace(/\n/g, ' ')}`);
	}
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
		const lines = img
			? [`> [!quote] Image`, `> ![${img.alt}|${IMAGE_DISPLAY_WIDTH}](${img.src})`]
			: [`> [!quote] ${mark(h.content, h.color)}`];
		const comments = commentsCallout(h.notes, '> ');
		if (comments) lines.push('>', comments);
		nodes.push(lines.join('\n'));
	}
	const body = nodes.join('\n\n---\n\n');
	return [`## Highlights — ${title}`, '', `[Open original](${url})`, '', body].join('\n');
}

// --- YouTube video annotations ----------------------------------------------

export interface VideoBlockResult {
	markdown: string;
	// Frame images to upload: attachment filename (within <folder>/Attachments) → dataUrl.
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
		const lines: string[] = [];
		if (it.kind === 'transcript') {
			const range = it.timeEnd != null ? `${mmss(it.videoTime)}–${mmss(it.timeEnd)}` : mmss(it.videoTime);
			lines.push(`> [!quote] ${timeLink(url, it.videoTime, range)}`);
			if (it.quote) lines.push(`> ${mark(it.quote, it.color)}`);
		} else if (it.kind === 'frame') {
			lines.push(`> [!info] ${timeLink(url, it.videoTime, mmss(it.videoTime))}`);
			if (it.frame?.dataUrl) {
				const filename = `youtube-${videoId}-${it.id}.jpg`;
				attachments.push({ filename, dataUrl: it.frame.dataUrl });
				// Cap display width (don't upscale past the frame's natural width).
				const width = Math.min(it.frame.w || IMAGE_DISPLAY_WIDTH, IMAGE_DISPLAY_WIDTH);
				lines.push(`> ![[${filename}|${width}]]`);
			}
		} else {
			lines.push(`> [!note] ${timeLink(url, it.videoTime, mmss(it.videoTime))}`);
		}
		const comments = commentsCallout(it.notes, '> ');
		if (comments) lines.push('>', comments);
		nodes.push(lines.join('\n'));
	}

	const body = nodes.join('\n\n---\n\n');
	const markdown = [`## ${title}`, '', `[Watch on YouTube](${url})`, '', body].join('\n');
	return { markdown, attachments };
}

// --- Managed region assembly -------------------------------------------------

function frontmatter(props: Record<string, string>): string {
	const lines = ['---'];
	for (const [k, v] of Object.entries(props)) lines.push(`${k}: ${JSON.stringify(v)}`);
	lines.push('---');
	return lines.join('\n');
}

/**
 * Produce the final note contents. If `existing` already contains our managed
 * region we swap just that region (preserving the user's own edits); otherwise
 * we create the file with frontmatter + the region, or append the region to a
 * pre-existing non-managed note.
 */
export function assembleNote(
	existing: string | null,
	block: string,
	props: Record<string, string>,
): string {
	const region = `${REGION_START}\n${block}\n${REGION_END}`;
	if (existing) {
		const startIdx = existing.indexOf(REGION_START);
		const endIdx = existing.indexOf(REGION_END);
		if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
			return existing.slice(0, startIdx) + region + existing.slice(endIdx + REGION_END.length);
		}
		return `${existing.trimEnd()}\n\n${region}\n`;
	}
	return `${frontmatter(props)}\n\n${region}\n`;
}
