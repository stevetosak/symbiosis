// Stubs: a function whose body is only a `TODO(pi)` comment and placeholders
// (core/syntax). The developer writes the signature and a one-line intent
// above it; the agent fills the body and nothing else (core/guard.ts).
// Pure: it reads outlines, never the parser.
import type { Fn, Outline } from './syntax/outline.ts';

/** The stub being filled, as the guard finds it again after each edit. */
export interface StubRef {
	kind: 'stub';
	/** Absolute path of its file. */
	path: string;
	name: string;
	/** The signature's text with its whitespace collapsed (`normalize`). */
	signature: string;
	/** Its first line when the fill started: picks between two equal signatures. */
	line: number;
}

/** Whitespace runs as one space, trimmed: a re-indent is not a change. */
export function normalize(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

export function stubRef(path: string, text: string, fn: Fn): StubRef {
	return { kind: 'stub', path, name: fn.name, signature: normalize(text.slice(fn.signature.start, fn.signature.end)), line: fn.line };
}

/** The innermost stub whose lines hold `line` (1-based). */
export function stubAt(outline: Outline, line: number): Fn | undefined {
	return outline.functions
		.filter((f) => f.stub && f.line <= line && line <= f.endLine)
		.sort((a, b) => b.line - a.line)[0];
}

/**
 * The function of `ref` in a new version of its file: the same signature, the
 * one nearest its old line. With `byName`, the same name is enough (an
 * accepted signature change).
 */
export function locate(outline: Outline, text: string, ref: StubRef, byName = false): Fn | undefined {
	// An anonymous function has no name to find it by.
	if (byName && ref.name === '') return undefined;
	const same = outline.functions.filter((f) =>
		byName ? f.name === ref.name : normalize(text.slice(f.signature.start, f.signature.end)) === ref.signature,
	);
	return same.sort((a, b) => Math.abs(a.line - ref.line) - Math.abs(b.line - ref.line))[0];
}

/** The user message that asks the agent to fill one stub. `shown` is the path as the agent should see it. */
export function fillMessage(shown: string, text: string, fn: Fn): string {
	const signature = text.slice(fn.signature.start, fn.signature.end).trim();
	return [
		`Fill the stub \`${fn.name || 'anonymous'}\` in ${shown} (lines ${fn.line}-${fn.endLine}).`,
		fn.intent ? `Intent: ${fn.intent}` : 'Intent: none written; infer it from the name and the signature.',
		'Signature:',
		'```',
		signature,
		'```',
		'Rules:',
		'- Edit only inside this function body. Replace the TODO(pi) marker and the placeholder.',
		'- Do not change the signature, add a top-level declaration, create a file, or add a dependency. Local helpers inside the body are fine.',
		'- When the task needs one of those, call `propose` and wait for the answer.',
		'- Give each edit a short `why` for every choice that is not obvious: error handling, I/O, shared state, retries, caching.',
	].join('\n');
}
