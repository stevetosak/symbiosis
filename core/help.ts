// helpi!: inline help while you write code. Pure parts, so the tests need no
// pi and no ttt.
//
// You end a comment with `helpi!`. The ttt plugin sends the comment and the
// code around it (help.json); the pi session the editor follows asks its own
// model in a side call, outside its conversation. The model answers with a
// kind on the first line:
//   note  an answer to read: comment lines under your question
//   code  the code for that place: it takes the place of your comment
//   ask   it needs more than this code: the question goes to the main session
import { relative } from 'node:path';
import type { HelpKind, HelpRequest, Step } from './protocol.ts';

/** A help request from the plugin's JSON, or undefined when it is not one. */
export function parseRequest(value: unknown): HelpRequest | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const r = value as Record<string, unknown>;
	if (typeof r.id !== 'string' || typeof r.to !== 'string') return undefined;
	const window = (r.window ?? {}) as Record<string, unknown>;
	return {
		id: r.id,
		to: r.to,
		path: typeof r.path === 'string' ? r.path : '',
		line: typeof r.line === 'number' ? r.line : 1,
		question: typeof r.question === 'string' ? r.question : '',
		language: typeof r.language === 'string' ? r.language : '',
		head: typeof r.head === 'string' ? r.head : '',
		window: {
			first: typeof window.first === 'number' ? window.first : 1,
			text: typeof window.text === 'string' ? window.text : '',
		},
		cancel: r.cancel === true,
	};
}

export const HELP_SYSTEM = `You help a developer who writes code in an editor. They ended a comment with \`helpi!\`: that comment is their question, or what they want at that place. Answer at once, with no preamble.

The first line of your reply is the kind of answer, alone: note, code, function or ask.

code: the comment asks for code at that place ("how do I make a directory here", "loop over the items and sum the prices"). After the kind, write only the code that takes the place of the comment, in the file's language and style. Indent it from column 0: the editor adds the indent of the comment's line. No explanation, no Markdown fences. When the code needs an import that the file does not have, put each import first, on its own line, as \`+import \` and then the whole import line, for example:
+import import { mkdirSync } from 'node:fs';

function: the comment describes a whole new function to write there, outside any function body ("a function that parses the header and returns its fields"). Write nothing after the kind: the agent writes the function under the comment, with its tools.

note: the comment asks something to understand ("why does this need a cast?"). After the kind, write the answer as plain lines of at most 80 characters. No Markdown fences and no comment markers: the editor makes each line a comment.

ask: you cannot answer well from the code you see, because it needs the whole project, the task the agent works on, commands to run, or changes in many places. Write nothing after the kind: the question goes to the agent that does the task.`;

/** The text with a line number in front of each line, from `first`. */
export function numbered(text: string, first: number): string {
	return text
		.split('\n')
		.map((l, i) => `${String(first + i).padStart(5)}| ${l}`)
		.join('\n');
}

/** The user message of the side call. */
export function helpPrompt(req: HelpRequest, cwd: string, plan: Step[], lastMessage: string | undefined): string {
	const path = req.path ? relative(cwd, req.path) || req.path : '(unsaved file)';
	const parts = [`File: ${path}${req.language ? ` (${req.language})` : ''}`];
	if (req.head) parts.push(`The top of the file:\n${numbered(req.head, 1)}`);
	const last = req.window.first + req.window.text.split('\n').length - 1;
	parts.push(`${req.head ? `Lines ${req.window.first}-${last}` : 'The whole file'}:\n${numbered(req.window.text, req.window.first)}`);
	parts.push(`The comment is line ${req.line}:\n${req.question.trim()}`);
	if (plan.length > 0) parts.push(`The agent's plan:\n${plan.map((s) => `- [${s.state}] ${s.text}`).join('\n')}`);
	if (lastMessage) parts.push(`The agent's last message:\n${lastMessage}`);
	return parts.join('\n\n');
}

/** The message to the main session when the side call answers `ask`. */
export function askMessage(req: HelpRequest, cwd: string): string {
	const path = req.path ? relative(cwd, req.path) || req.path : '(unsaved file)';
	const note = req.question
		.replace(/\s*helpi!\s*(\*\/|-->)?\s*$/, '')
		.replace(/^\s*(\/\/|#|--|;|\/\*|\*|<!--)\s*/, '')
		.trim();
	return [
		`A question from the editor (helpi!), at ${path}:${req.line}:`,
		'',
		note,
		'',
		'Answer it in your reply. The code there, as in the editor (it may not be saved):',
		'```',
		req.window.text,
		'```',
	].join('\n');
}

const KINDS: HelpKind[] = ['note', 'code', 'function', 'ask'];
const IMPORT = '+import ';
const FENCE = /^\s*```/;

export interface HelpAnswer {
	/** Undefined until the first line is complete. */
	kind?: HelpKind;
	imports: string[];
	/** The text for the buffer, without fences. */
	body: string;
	/** True once the kind and the imports are known: the answer can start in the buffer. */
	settled: boolean;
}

/**
 * The answer so far, from all the model wrote (`raw`). Called on every delta.
 * `final`: the model is done; the last line is complete.
 */
export function parseAnswer(raw: string, final: boolean): HelpAnswer {
	const nl = raw.indexOf('\n');
	if (nl < 0 && !final) return { imports: [], body: '', settled: false };
	const first = (nl < 0 ? raw : raw.slice(0, nl)).trim().toLowerCase().replace(/[^a-z]/g, '');
	let kind = KINDS.find((k) => k === first);
	let rest = nl < 0 ? '' : raw.slice(nl + 1);
	// No kind line: all of it is a note.
	if (!kind) {
		kind = 'note';
		rest = raw;
	}
	const imports: string[] = [];
	if (kind === 'code') {
		for (;;) {
			const lineEnd = rest.indexOf('\n');
			const line = lineEnd < 0 ? rest : rest.slice(0, lineEnd);
			const complete = lineEnd >= 0 || final;
			// A line that may still become an import: wait for its end.
			if (!complete && (IMPORT.startsWith(line) || line.startsWith(IMPORT))) {
				return { kind, imports, body: '', settled: false };
			}
			if (!line.startsWith(IMPORT) || !complete) break;
			const text = line.slice(IMPORT.length).trim();
			if (text) imports.push(text);
			rest = lineEnd < 0 ? '' : rest.slice(lineEnd + 1);
		}
	}
	let lines = rest.split('\n');
	// A last line that may still become a fence waits for its end.
	const tail = lines[lines.length - 1];
	if (!final && /^\s*`{1,3}[\w+-]*$/.test(tail)) lines[lines.length - 1] = '';
	lines = lines.filter((l, i) => !(FENCE.test(l) && (i < lines.length - 1 || final)));
	let body = lines.join('\n');
	if (kind === 'note') body = body.replace(/^\s*pi:\s*/, '');
	body = body.replace(/^(\s*\n)+/, '');
	if (final) body = body.replace(/\s+$/, '');
	return { kind, imports, body: kind === 'ask' || kind === 'function' ? '' : body, settled: true };
}

/** The text of the last assistant message on the session branch, at most `max` characters. */
export function lastAssistantText(branch: unknown[], max = 2000): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { type?: string; message?: { role?: string; content?: unknown } };
		if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
		const content = entry.message.content;
		const text = Array.isArray(content)
			? content
					.filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
					.map((c) => c.text)
					.join('\n')
			: typeof content === 'string'
				? content
				: '';
		if (text.trim()) return text.length > max ? `…${text.slice(-max)}` : text;
	}
	return undefined;
}
