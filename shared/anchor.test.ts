import { describe, test, expect } from 'vitest';
import { parseHTML } from 'linkedom';
import {
	buildTextQuote,
	findTextQuote,
	createAnchor,
	resolveAnchor,
	locateRange,
	offsetsFromRange,
	buildTextMap,
	type AnnotationAnchor,
	type RangeLike,
} from './anchor';

/** Text spanned by a resolved range, derived without the native Range API. */
function textOf(root: Node, range: RangeLike): string {
	const offs = offsetsFromRange(root, range)!;
	return buildTextMap(root).text.slice(offs.start, offs.end);
}

describe('text-quote core (pure)', () => {
	const text = 'The quick brown fox jumps over the lazy dog. The fox is quick.';

	test('builds quote with surrounding context', () => {
		const start = text.indexOf('brown fox');
		const q = buildTextQuote(text, start, start + 'brown fox'.length);
		expect(q.quote).toBe('brown fox');
		expect(q.prefix.endsWith('quick ')).toBe(true);
		expect(q.suffix.startsWith(' jumps')).toBe(true);
		expect(q.occurrence).toBe(0);
	});

	test('round-trips a unique quote', () => {
		const start = text.indexOf('lazy dog');
		const q = buildTextQuote(text, start, start + 'lazy dog'.length);
		expect(findTextQuote(text, q)).toBe(start);
	});

	test('disambiguates a repeated quote by context + occurrence', () => {
		const first = text.indexOf('fox');
		const second = text.indexOf('fox', first + 1);
		const q1 = buildTextQuote(text, first, first + 3);
		const q2 = buildTextQuote(text, second, second + 3);
		expect(findTextQuote(text, q1)).toBe(first);
		expect(findTextQuote(text, q2)).toBe(second);
	});

	test('returns null when the quote is absent', () => {
		expect(findTextQuote(text, buildTextQuote('cat', 0, 3))).toBeNull();
	});
});

describe('DOM anchoring (linkedom)', () => {
	function setup(html: string) {
		const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
		return document.body;
	}

	function anchorFor(root: Node, phrase: string, surface: 'web' | 'obsidian') {
		const full = buildTextMap(root).text;
		const start = full.indexOf(phrase);
		const range = locateRange(root, start, start + phrase.length)!;
		return createAnchor(range, root, surface)!;
	}

	test('offset <-> range round-trip across nested elements', () => {
		const root = setup('<p>Hello <b>brave</b> new world</p>');
		const range = locateRange(root, 6, 11); // "brave"
		expect(range).not.toBeNull();
		expect(textOf(root, range!)).toBe('brave');
		expect(offsetsFromRange(root, range!)).toEqual({ start: 6, end: 11 });
	});

	test('createAnchor then resolveAnchor on the same surface', () => {
		const root = setup('<p>Annotate <em>this exact phrase</em> please.</p>');
		const anchor = anchorFor(root, 'this exact phrase', 'web');
		expect(anchor.quote.quote).toBe('this exact phrase');
		expect(anchor.structural?.surface).toBe('web');
		const resolved = resolveAnchor(anchor as AnnotationAnchor, root, 'web');
		expect(resolved).not.toBeNull();
		expect(textOf(root, resolved!)).toBe('this exact phrase');
	});

	test('cross-surface: structural ignored, text-quote still resolves', () => {
		// Capture on "web" against one DOM ...
		const webRoot = setup('<article><h1>Title</h1><p>The shared sentence lives here.</p></article>');
		const anchor = anchorFor(webRoot, 'shared sentence', 'web');

		// ... resolve on "obsidian" against a *different* DOM containing the same words.
		const mdRoot = setup('<div class="markdown"><p>Intro.</p><blockquote>The shared sentence lives here.</blockquote></div>');
		const resolved = resolveAnchor(anchor, mdRoot, 'obsidian');
		expect(resolved).not.toBeNull();
		expect(textOf(mdRoot, resolved!)).toBe('shared sentence');
	});

	test('unplaced when text is absent on the target surface', () => {
		const webRoot = setup('<p>Only on the web page.</p>');
		const anchor = anchorFor(webRoot, 'the web page', 'web');
		const mdRoot = setup('<p>Completely different note content.</p>');
		expect(resolveAnchor(anchor, mdRoot, 'obsidian')).toBeNull();
	});
});
