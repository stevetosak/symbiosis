// Review per stub: what the developer reads when the agent filled a body. A
// `Landing` is the filled function as plain data (signature, intent, body);
// a `Landed` adds the agent's reasons (`why`) and an id the developer's `a`
// answers. Pure: pi/review.ts keeps the list, the plugin shows it.
import type { Fn } from './syntax/outline.ts';

/** The most lines of a body the drawer shows; a longer body ends with "…". */
export const BODY_MAX = 120;

/** The most un-acked bodies a session keeps; the oldest drop first. */
export const LANDED_MAX = 20;

export interface Landing {
	path: string;
	/** The function's name, or "" for an anonymous one. */
	name: string;
	/** 1-based lines of the whole function. */
	line: number;
	endLine: number;
	/** `function add(a: number, b: number): number`, one line. */
	signature: string;
	/** The doc comment above, without comment marks. Empty when there is none. */
	intent: string;
	/** The body as written, without blank edge lines and common indent. */
	body: string;
	/** The function's first line as it is in the file: the plugin finds the function again by it. */
	anchor: string;
}

export interface Landed extends Landing {
	id: string;
	/** The reasons the agent gave for its changes to the file in that turn. */
	whys: string[];
	/** Unix seconds. */
	time: number;
}

/** What `ack` in review.json names: the plugin acks body `ack` of session `to`. */
export interface ReviewRequest {
	id: string;
	to: string;
	ack: string;
}

export function parseReviewRequest(raw: unknown): ReviewRequest | undefined {
	if (typeof raw !== 'object' || raw === null) return undefined;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== 'string' || typeof r.to !== 'string' || typeof r.ack !== 'string') return undefined;
	return { id: r.id, to: r.to, ack: r.ack };
}

/** The text with blank edge lines cut and the indent every line shares removed. */
export function dedent(text: string): string {
	const lines = text.replace(/\t/g, '    ').split('\n');
	while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]?.trim() === '') lines.pop();
	const indents = lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length);
	const cut = indents.length === 0 ? 0 : Math.min(...indents);
	return lines.map((l) => l.slice(cut).trimEnd()).join('\n');
}

/** The first `max` lines of `text`; a cut body ends with a line "…". */
export function capLines(text: string, max = BODY_MAX): string {
	const lines = text.split('\n');
	return lines.length <= max ? text : [...lines.slice(0, max), '…'].join('\n');
}

/** The text between the braces of a brace body; any other body as it is. */
function inBraces(body: string): string {
	const text = body.trim();
	return text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : body;
}

/** The filled function `fn` of `text`, as the drawer shows it. */
export function landingOf(path: string, text: string, fn: Fn): Landing {
	const firstLine = text.slice(0, fn.range.start).split('\n').length - 1;
	const anchor = text.split('\n')[firstLine] ?? '';
	return {
		path,
		name: fn.name,
		line: fn.line,
		endLine: fn.endLine,
		signature: text.slice(fn.range.start, fn.signature.end).replace(/\s+/g, ' ').trim(),
		intent: fn.intent ?? '',
		body: capLines(dedent(inBraces(text.slice(fn.body.start, fn.body.end)))),
		anchor: anchor.trim(),
	};
}

/**
 * `list` with `landed` added. The same function (path and name) filled again
 * replaces the older entry; the list keeps `LANDED_MAX` entries, the newest last.
 */
export function addLanded(list: Landed[], landed: Landed): Landed[] {
	const rest = list.filter((l) => !(l.path === landed.path && l.name === landed.name));
	return [...rest, landed].slice(-LANDED_MAX);
}
