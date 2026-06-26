// Dependency-free approximate (fuzzy) string matching.
//
// `shared/` is bundled by BOTH the extension and the Obsidian plugin and must
// stay free of external dependencies, so we cannot import the `approx-string-match`
// package the Hypothesis client uses. This is a self-contained port of the same
// idea (edit-distance substring search) using a straightforward banded
// dynamic-programming scan. It is only ever invoked as a last-resort anchor
// fallback (after exact and whitespace-insensitive matching both fail), so the
// O(n·m) cost is acceptable.

export interface ApproxMatch {
	/** Start offset of the match in the searched text. */
	start: number;
	/** End offset (exclusive). */
	end: number;
	/** Edit distance between the matched text and the pattern. */
	errors: number;
}

/**
 * Return end offsets in `text` of approximate matches of `pattern` whose edit
 * distance is `<= maxErrors`. When `allPositions` is false, contiguous runs of
 * qualifying end positions are collapsed to their lowest-error position (one
 * candidate per local-best region); when true, every qualifying end is returned
 * (used by the reverse pass to recover match starts).
 */
function searchEnds(
	text: string,
	pattern: string,
	maxErrors: number,
	allPositions: boolean,
): { end: number; errors: number }[] {
	const m = pattern.length;
	const n = text.length;
	const out: { end: number; errors: number }[] = [];
	if (m === 0) return out;

	// Rolling columns of the edit-distance matrix. Row 0 is pinned to 0 so the
	// match may start at any position in `text` (substring search).
	let prev = new Int32Array(m + 1);
	let cur = new Int32Array(m + 1);
	for (let i = 0; i <= m; i++) prev[i] = i;

	let runEnd = -1;
	let runErr = Infinity;
	for (let j = 1; j <= n; j++) {
		cur[0] = 0;
		const tc = text.charCodeAt(j - 1);
		for (let i = 1; i <= m; i++) {
			const cost = pattern.charCodeAt(i - 1) === tc ? 0 : 1;
			let v = prev[i - 1]! + cost; // substitute / match
			const del = prev[i]! + 1; // skip a pattern char (insertion in text)
			if (del < v) v = del;
			const ins = cur[i - 1]! + 1; // skip a text char (deletion from text)
			if (ins < v) v = ins;
			cur[i] = v;
		}
		const e = cur[m]!;
		if (allPositions) {
			if (e <= maxErrors) out.push({ end: j, errors: e });
		} else {
			if (e <= maxErrors && e < runErr) {
				runErr = e;
				runEnd = j;
			}
			if (runEnd !== -1 && e > runErr) {
				out.push({ end: runEnd, errors: runErr });
				runEnd = -1;
				runErr = Infinity;
			}
		}
		const tmp = prev;
		prev = cur;
		cur = tmp;
	}
	if (!allPositions && runEnd !== -1) out.push({ end: runEnd, errors: runErr });
	return out;
}

function reverse(s: string): string {
	return s.split('').reverse().join('');
}

/**
 * Find approximate matches of `pattern` in `text` allowing up to `maxErrors`
 * edits. Each result carries its `start`, `end`, and `errors`. The start of a
 * match is recovered by re-running the scan on a reversed window before the end
 * (mirroring the technique in `approx-string-match`), choosing the longest
 * span so interior edits don't truncate the match.
 */
export function approxMatch(text: string, pattern: string, maxErrors: number): ApproxMatch[] {
	if (pattern.length === 0 || text.length === 0 || maxErrors < 0) return [];
	const ends = searchEnds(text, pattern, maxErrors, false);
	const patRev = reverse(pattern);
	return ends.map(({ end, errors }) => {
		const minStart = Math.max(0, end - pattern.length - errors);
		const textRev = reverse(text.slice(minStart, end));
		const revEnds = searchEnds(textRev, patRev, errors, true);
		let start = end;
		for (const re of revEnds) {
			const s = end - re.end;
			if (s < start) start = s;
		}
		return { start, end, errors };
	});
}
