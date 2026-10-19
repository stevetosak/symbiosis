// Which lines a change touched: a line diff of the text before and after.
// Pure; the `diff` package does the work.
import { structuredPatch } from 'diff';
import type { Hunk } from './protocol.ts';

/** The hunks that turn `before` into `after`, no context lines. `before` null: a new file. */
export function hunksOf(before: string | null, after: string): Hunk[] {
	const patch = structuredPatch('a', 'b', before ?? '', after, '', '', { context: 0 });
	return patch.hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines }));
}

/**
 * Where a line of the file stands after a later change; null when the later
 * change replaced it. `later` are that change's hunks, in the `diff`
 * convention: a range with 0 lines at S sits before line S.
 */
export function moveLine(line: number, later: Hunk[]): number | null {
	let shift = 0;
	for (const h of later) {
		if (line < h.oldStart) break;
		if (line < h.oldStart + h.oldLines) return null;
		shift += h.newLines - h.oldLines;
	}
	return line + shift;
}
