// A place for a new function: the developer describes it in a comment
// (`// a function that ... helpi!`) and the agent writes it, signature and
// body, directly under the description. The guard (core/guard.ts) lets the
// agent change only that one declaration and add imports.
//
// The place is found again in each version of the file by the description's
// text, nearest its old line. The new function is the declaration whose doc
// comment holds the description (no blank line between them). Pure: it reads
// outlines, never the parser.
import { normalize } from './stubs.ts';
import type { Decl, Outline, Range } from './syntax/outline.ts';

/** A new function being written under its description. */
export interface PlaceRef {
	kind: 'place';
	/** Absolute path of its file. */
	path: string;
	/** The description's comment lines, as in the file, without the indent before the first. */
	description: string;
	/** Its first line when last found: picks between two equal descriptions. */
	line: number;
	/** The new declaration's name once it is written; "" before. */
	name: string;
}

/** The place in one version of the file. */
export interface FoundPlace {
	/** The description's text. */
	description: Range;
	/** 1-based line where the description starts. */
	line: number;
	/** The new declaration, once written: the one whose doc comment holds the description. */
	decl: Decl | undefined;
	/** What the agent may change: from the end of the description to the end of the declaration. */
	region: Range;
}

/** A comment line in any of the languages symbiosis parses (and in the ones it does not). */
const COMMENT_LINE = /^\s*(\/\/|#|--|;|\/\*|\*|<!--)/;

/**
 * The description that ends at `line` (1-based): that comment line and the
 * comment lines right above it. Undefined when `line` is not a comment.
 */
export function describeAt(text: string, line: number): { description: string; line: number } | undefined {
	const lines = text.split('\n');
	const last = line - 1;
	if (!COMMENT_LINE.test(lines[last] ?? '')) return undefined;
	let first = last;
	while (first > 0 && COMMENT_LINE.test(lines[first - 1])) first--;
	const description = lines
		.slice(first, last + 1)
		.join('\n')
		.trim();
	return description ? { description, line: first + 1 } : undefined;
}

function lineAt(text: string, offset: number): number {
	let line = 1;
	for (let i = text.indexOf('\n'); i >= 0 && i < offset; i = text.indexOf('\n', i + 1)) line++;
	return line;
}

/** The place of `ref` in a version of its file; undefined when its description is gone. */
export function findPlace(outline: Outline, text: string, ref: PlaceRef): FoundPlace | undefined {
	let best: { start: number; line: number } | undefined;
	for (let at = text.indexOf(ref.description); at >= 0; at = text.indexOf(ref.description, at + 1)) {
		const line = lineAt(text, at);
		if (!best || Math.abs(line - ref.line) < Math.abs(best.line - ref.line)) best = { start: at, line };
	}
	if (!best) return undefined;
	const description = { start: best.start, end: best.start + ref.description.length };
	const decl = outline.decls
		.filter((d) => d.doc && d.doc.start <= description.start && d.doc.end >= description.end)
		.sort((a, b) => a.range.start - b.range.start)[0];
	return { description, line: best.line, decl, region: { start: description.end, end: decl ? decl.range.end : description.end } };
}

/** True when `offset` is inside a function's body: no declaration goes there. */
export function inBody(outline: Outline, offset: number): boolean {
	return outline.functions.some((f) => f.body.start <= offset && offset < f.body.end);
}

/** The user message that asks the agent to write the function. `shown` is the path as the agent should see it. */
export function placeMessage(shown: string, ref: PlaceRef): string {
	const lines = ref.description.split('\n').length;
	return [
		`Write a new function in ${shown}, directly under the description at line ${ref.line}${lines > 1 ? `-${ref.line + lines - 1}` : ''}:`,
		'```',
		ref.description,
		'```',
		'Rules:',
		'- Write the whole function: its signature and its body. Put it directly under the description, with no blank line between, and keep the description as it is: it stays as the function\'s comment.',
		'- Change nothing else in the file except new import lines. Local helpers inside the body are fine.',
		'- Do not add another top-level declaration, create a file, or add a dependency. When the task needs one of those, call `propose` and wait for the answer.',
		'- Give each edit a short `why` for every choice that is not obvious: error handling, I/O, shared state, retries, caching.',
	].join('\n');
}

/** The description's first line, short: how the editor names the place before the function has a name. */
export function placeTitle(ref: PlaceRef): string {
	const first = normalize(ref.description.split('\n')[0].replace(COMMENT_LINE, ''));
	return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}
