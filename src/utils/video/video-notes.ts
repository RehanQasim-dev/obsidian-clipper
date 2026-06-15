// Small shared helpers for video chat-thread messages, mirroring the comment
// format used by page highlights: each note is "text<!--timestamp:N-->" with an
// optional "<!--edited:M-->". Shared by the in-page annotator panel and the
// dashboard so both parse/render messages identically.

export interface ParsedNote {
	text: string;
	timestamp?: number; // creation ms (stable id)
	edited?: number;    // last-edit ms
}

export function parseVideoNote(note: string): ParsedNote {
	const tsMatch = note.match(/<!--timestamp:(\d+)-->/);
	const edMatch = note.match(/<!--edited:(\d+)-->/);
	const text = note
		.replace(/<!--timestamp:\d+-->/, '')
		.replace(/<!--edited:\d+-->/, '')
		.trim();
	return {
		text,
		timestamp: tsMatch ? parseInt(tsMatch[1]) : undefined,
		edited: edMatch ? parseInt(edMatch[1]) : undefined,
	};
}

export function makeVideoNote(text: string, timestamp: number): string {
	return `${text}<!--timestamp:${timestamp}-->`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Render a small, safe subset of inline markdown (links, bold, italic) over
// already-escaped text. Mirrors renderInlineMarkdown in comment-overlays.ts.
export function renderNoteHtml(text: string): string {
	return escapeHtml(text)
		.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/\*([^*\s][^*]*?)\*/g, '<em>$1</em>')
		.replace(/\n/g, '<br>');
}

// Seconds → "M:SS" or "H:MM:SS" for the video-time badge.
export function formatVideoTime(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const pad = (n: number) => n.toString().padStart(2, '0');
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
