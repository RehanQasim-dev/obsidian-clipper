import { VideoColor, VideoMarkup } from './video-storage';

// Renders frame markup (strokes / straight lines / text labels) into an SVG that
// can be laid over a frame at any size. Coordinates in the markup are normalized
// 0..1; the caller passes the pixel box (W×H) to render into, and the SVG uses a
// matching viewBox with preserveAspectRatio:none so it stretches with the frame.
// Shared by the live annotator (repaint after each edit) and the dashboard.

const SVG_NS = 'http://www.w3.org/2000/svg';

export const VIDEO_COLOR_HEX: Record<VideoColor, string> = {
	yellow: '#facc15',
	red: '#fb7185',
	green: '#4ac582',
	black: '#000000',
};

// Smoothed path through normalized points, denormalized to the W×H box.
// Quadratic curves through successive midpoints (mirrors the pencil tool).
function strokePath(points: number[], W: number, H: number): string {
	if (points.length < 2) return '';
	const px = (i: number) => points[i] * W;
	const py = (i: number) => points[i + 1] * H;
	let d = `M ${px(0)} ${py(0)}`;
	if (points.length < 6) {
		for (let i = 2; i < points.length; i += 2) d += ` L ${px(i)} ${py(i)}`;
		return d;
	}
	for (let i = 2; i < points.length - 2; i += 2) {
		const xc = (px(i) + px(i + 2)) / 2;
		const yc = (py(i) + py(i + 2)) / 2;
		d += ` Q ${px(i)} ${py(i)} ${xc} ${yc}`;
	}
	d += ` L ${px(points.length - 2)} ${py(points.length - 2)}`;
	return d;
}

export function renderMarkupSvg(markup: VideoMarkup | undefined, W: number, H: number, selectedId?: string | null): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
	svg.setAttribute('preserveAspectRatio', 'none');
	svg.setAttribute('class', 'ob-video-markup-svg');
	if (!markup) return svg;

	// Stroke weight scales with the frame so it reads the same at any display size.
	const getWeight = (w?: string) => {
		const baseWeight = Math.max(2, W * 0.004);
		if (w === 'thin') return baseWeight * 0.5;
		if (w === 'thick') return baseWeight * 2;
		return baseWeight;
	};

	for (const s of markup.strokes) {
		const p = document.createElementNS(SVG_NS, 'path');
		p.setAttribute('d', strokePath(s.points, W, H));
		p.setAttribute('fill', 'none');
		p.setAttribute('stroke', VIDEO_COLOR_HEX[s.color]);
		p.setAttribute('stroke-width', String(getWeight(s.weight)));
		p.setAttribute('stroke-linecap', 'round');
		p.setAttribute('stroke-linejoin', 'round');
		p.setAttribute('data-mid', s.id);
		if (s.id === selectedId) p.classList.add('is-selected');
		svg.appendChild(p);
	}

	for (const l of markup.lines) {
		const ln = document.createElementNS(SVG_NS, 'line');
		ln.setAttribute('x1', String(l.x1 * W));
		ln.setAttribute('y1', String(l.y1 * H));
		ln.setAttribute('x2', String(l.x2 * W));
		ln.setAttribute('y2', String(l.y2 * H));
		ln.setAttribute('stroke', VIDEO_COLOR_HEX[l.color]);
		ln.setAttribute('stroke-width', String(getWeight(l.weight)));
		ln.setAttribute('stroke-linecap', 'round');
		ln.setAttribute('data-mid', l.id);
		if (l.id === selectedId) ln.classList.add('is-selected');
		svg.appendChild(ln);
	}

	// Text labels render in a fixed-width box that wraps. A <foreignObject> holding
	// an HTML div gives natural word-wrapping (plain SVG <text> can't wrap), and
	// matches what the user typed in the live textarea.
	for (const t of markup.texts) {
		const boxW = (t.w && t.w > 0 ? t.w : 0.28) * W;
		const fo = document.createElementNS(SVG_NS, 'foreignObject');
		fo.setAttribute('x', String(t.x * W));
		fo.setAttribute('y', String(t.y * H));
		fo.setAttribute('width', String(boxW));
		fo.setAttribute('height', String(H)); // generous; the div sizes to content
		fo.setAttribute('data-mid', t.id);
		const div = document.createElement('div');
		div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
		const fontSize = Math.max(11, H * 0.034) * (t.size ?? 1);
		div.style.cssText = `display:inline-block;width:${boxW}px;`
			+ `font:600 ${fontSize}px system-ui,sans-serif;line-height:1.3;`
			+ `color:${VIDEO_COLOR_HEX[t.color]};white-space:pre-wrap;`
			+ `overflow-wrap:break-word;word-break:break-word;`
			+ `margin:0;padding:2px;box-sizing:border-box;`
			+ (t.color === 'black' ? `text-shadow:0 1px 2px rgba(255,255,255,0.7), 0 0 4px rgba(255,255,255,0.5);` : `text-shadow:0 1px 2px rgba(0,0,0,0.7);`)
			+ (t.id === selectedId ? `outline:2px dashed rgba(255,255,255,0.9);outline-offset:2px;` : '');
		div.textContent = t.text;
		fo.appendChild(div);
		svg.appendChild(fo);
	}

	return svg;
}

// Snap a line's angle to the nearest 45° increment (used while Shift is held).
// Returns the snapped end point given the fixed start point.
export function snapLineTo45(x0: number, y0: number, x1: number, y1: number): { x: number; y: number } {
	const dx = x1 - x0;
	const dy = y1 - y0;
	const len = Math.hypot(dx, dy);
	if (len === 0) return { x: x1, y: y1 };
	const angle = Math.atan2(dy, dx);
	const step = Math.PI / 4; // 45°
	const snapped = Math.round(angle / step) * step;
	return { x: x0 + Math.cos(snapped) * len, y: y0 + Math.sin(snapped) * len };
}
