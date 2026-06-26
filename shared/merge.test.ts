import { describe, test, expect } from 'vitest';
import {
	mergeSyncFiles, emptySyncFile, type SyncFile, type Highlight,
	mergePageRecord, emptyPageRecord, type PageRecord, type PageDiagram,
} from './merge';

function fileWith(url: string, highlights: Highlight[]): SyncFile {
	const f = emptySyncFile();
	f.highlights[url] = { url, highlights };
	return f;
}

const URL = 'https://example.com/a';
const NOW = 1_000_000;

function hl(id: string, updatedAt: number, color = 'yellow', notes: string[] = []): Highlight {
	return { id, updatedAt, color, notes, type: 'text', content: id };
}
function comment(ts: number, text: string, edited?: number): string {
	return `${text}<!--timestamp:${ts}-->` + (edited ? `<!--edited:${edited}-->` : '');
}

describe('mergeSyncFiles — highlights', () => {
	test('keeps brand-new highlights from both local and remote', () => {
		const base = emptySyncFile();
		const local = fileWith(URL, [hl('1', 10)]);
		const remote = fileWith(URL, [hl('2', 20)]);
		const merged = mergeSyncFiles(base, local, remote, NOW);
		const ids = merged.highlights[URL].highlights.map((h) => h.id).sort();
		expect(ids).toEqual(['1', '2']);
	});

	test('newest edit wins when the same highlight differs on both sides', () => {
		const base = fileWith(URL, [hl('1', 10, 'yellow')]);
		const local = fileWith(URL, [hl('1', 30, 'green')]);
		const remote = fileWith(URL, [hl('1', 20, 'red')]);
		const merged = mergeSyncFiles(base, local, remote, NOW);
		expect(merged.highlights[URL].highlights[0].color).toBe('green');
	});

	test('local deletion (in base, gone locally, present remote) tombstones it', () => {
		const base = fileWith(URL, [hl('1', 10)]);
		const local = emptySyncFile();
		const remote = fileWith(URL, [hl('1', 10)]);
		const merged = mergeSyncFiles(base, local, remote, NOW);
		expect(merged.highlights[URL]).toBeUndefined();
		expect(merged.tombstones.highlights['1']).toBe(NOW);
	});

	test('a tombstone is not resurrected by a stale remote copy', () => {
		const base = emptySyncFile();
		base.tombstones.highlights['1'] = NOW - 1000;
		const local = emptySyncFile();
		const remote = fileWith(URL, [hl('1', NOW - 5000)]); // older than the delete
		// remote must also carry the tombstone for it to be respected
		remote.tombstones.highlights['1'] = NOW - 1000;
		const merged = mergeSyncFiles(base, local, remote, NOW);
		expect(merged.highlights[URL]).toBeUndefined();
	});

	test('re-editing locally after a remote delete resurrects the highlight', () => {
		const base = emptySyncFile();
		const local = fileWith(URL, [hl('1', NOW)]); // edited now
		const remote = emptySyncFile();
		remote.tombstones.highlights['1'] = NOW - 5000; // deleted earlier
		const merged = mergeSyncFiles(base, local, remote, NOW);
		expect(merged.highlights[URL].highlights[0].id).toBe('1');
		expect(merged.tombstones.highlights['1']).toBeUndefined();
	});
});

describe('mergeSyncFiles — comments', () => {
	test('keeps comments from both sides on the same highlight', () => {
		const base = fileWith(URL, [hl('1', 10, 'yellow', [comment(100, 'base')])]);
		const local = fileWith(URL, [hl('1', 11, 'yellow', [comment(100, 'base'), comment(200, 'from-local')])]);
		const remote = fileWith(URL, [hl('1', 12, 'yellow', [comment(100, 'base'), comment(300, 'from-remote')])]);
		const merged = mergeSyncFiles(base, local, remote, NOW);
		const texts = merged.highlights[URL].highlights[0].notes!.join('|');
		expect(texts).toContain('from-local');
		expect(texts).toContain('from-remote');
		expect(texts).toContain('base');
	});

	test('an edited comment keeps the most recent edit', () => {
		const base = fileWith(URL, [hl('1', 10, 'yellow', [comment(100, 'orig')])]);
		const local = fileWith(URL, [hl('1', 11, 'yellow', [comment(100, 'edited-local', 500)])]);
		const remote = fileWith(URL, [hl('1', 12, 'yellow', [comment(100, 'edited-remote', 400)])]);
		const merged = mergeSyncFiles(base, local, remote, NOW);
		expect(merged.highlights[URL].highlights[0].notes![0]).toContain('edited-local');
	});
});

function page(over: Partial<PageRecord>): PageRecord {
	return { ...emptyPageRecord(URL), ...over };
}
function diagram(id: string, updatedAt: number): PageDiagram {
	return { id, updatedAt, sceneData: { v: updatedAt } };
}

describe('mergePageRecord', () => {
	test('unions brand-new highlights, drawings, video, diagrams from both sides', () => {
		const base = emptyPageRecord(URL);
		const local = page({ highlights: [hl('h1', 10)], drawings: [{ id: 's1', updatedAt: 5 }], diagrams: [diagram('d1', 7)] });
		const remote = page({ highlights: [hl('h2', 20)], videoItems: [{ id: 'v1', updatedAt: 9 }] });
		const m = mergePageRecord(base, local, remote, NOW);
		expect(m.highlights.map(h => h.id).sort()).toEqual(['h1', 'h2']);
		expect(m.drawings.map(s => s.id)).toEqual(['s1']);
		expect(m.videoItems.map(v => v.id)).toEqual(['v1']);
		expect(m.diagrams.map(d => d.id)).toEqual(['d1']);
	});

	test('newest diagram edit wins, scene carried', () => {
		const base = page({ diagrams: [diagram('d1', 10)] });
		const local = page({ diagrams: [diagram('d1', 30)] });
		const remote = page({ diagrams: [diagram('d1', 20)] });
		const m = mergePageRecord(base, local, remote, NOW);
		expect(m.diagrams).toHaveLength(1);
		expect((m.diagrams[0].sceneData as any).v).toBe(30);
	});

	test('deleting a diagram (in base, gone locally, present remote) tombstones it', () => {
		const base = page({ diagrams: [diagram('d1', 10)] });
		const local = page({ diagrams: [] });
		const remote = page({ diagrams: [diagram('d1', 10)] });
		const m = mergePageRecord(base, local, remote, NOW);
		expect(m.diagrams).toHaveLength(0);
		expect(m.tombstones.diagrams['d1']).toBe(NOW);
	});

	test('a diagram tombstone is not resurrected by a stale remote copy', () => {
		const base = emptyPageRecord(URL);
		const local = emptyPageRecord(URL);
		const remote = page({ diagrams: [diagram('d1', NOW - 5000)] });
		remote.tombstones.diagrams['d1'] = NOW - 1000;
		const m = mergePageRecord(base, local, remote, NOW);
		expect(m.diagrams).toHaveLength(0);
	});

	test('merges comments from both sides on the same highlight', () => {
		const base = page({ highlights: [hl('h1', 10, 'yellow', [comment(100, 'base')])] });
		const local = page({ highlights: [hl('h1', 11, 'yellow', [comment(100, 'base'), comment(200, 'local')])] });
		const remote = page({ highlights: [hl('h1', 12, 'yellow', [comment(100, 'base'), comment(300, 'remote')])] });
		const m = mergePageRecord(base, local, remote, NOW);
		const texts = m.highlights[0].notes!.join('|');
		expect(texts).toContain('local');
		expect(texts).toContain('remote');
	});

	test('null base/local/remote are treated as empty', () => {
		const remote = page({ highlights: [hl('h1', 5)] });
		const m = mergePageRecord(null, null, remote, NOW);
		expect(m.highlights.map(h => h.id)).toEqual(['h1']);
		expect(m.url).toBe(URL);
	});
});

describe('mergeSyncFiles — isolation', () => {
	test('preserves remote drawings and video the merger does not touch', () => {
		const base = emptySyncFile();
		const local = fileWith(URL, [hl('1', 10)]);
		const remote = emptySyncFile();
		remote.drawings[URL] = { url: URL, strokes: [{ id: 's1', updatedAt: 5 }] };
		remote.videoAnnotations[URL] = { url: URL, items: [{ id: 'v1', updatedAt: 5 }] };
		const merged = mergeSyncFiles(base, local, remote, NOW);
		expect(merged.drawings[URL].strokes[0].id).toBe('s1');
		expect(merged.videoAnnotations[URL].items[0].id).toBe('v1');
		expect(merged.highlights[URL].highlights[0].id).toBe('1');
	});
});
