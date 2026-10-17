// ask: "what is this code, and why is it here?" without a comment in the file.
// Pure parts, so the tests need no pi and no ttt.
//
// The developer puts the cursor on code, selects it, or ends a line with
// `why!`, and presses `ctrl+k d`. The ttt plugin sends the code and the file
// (ask.json); the pi session the editor follows asks its own model in a side
// call, outside its conversation (the same path as helpi!, core/help.ts), with
// the context built here. The answer is a few lines, links, and key terms the
// developer can ask about in turn.
import { relative } from 'node:path';
import { numbered } from './help.ts';
import type { AskRequest, Link, Step } from './protocol.ts';
import type { Fn, Outline } from './syntax/outline.ts';

/** The most lines of the enclosing function sent to the model. */
const FUNCTION_MAX = 60;
/** Lines around the code when it is in no function. */
const AROUND = 12;
/** The most imports and terms kept. */
const IMPORTS_MAX = 30;
const TERMS_MAX = 5;
const TERM_MAX_CHARS = 40;
const LINKS_MAX = 4;

/** An ask request from the plugin's JSON, or undefined when it is not one. */
export function parseAskRequest(value: unknown): AskRequest | undefined {
	if (!value || typeof value !== 'object') return undefined;
	const r = value as Record<string, unknown>;
	if (typeof r.id !== 'string' || typeof r.to !== 'string') return undefined;
	const str = (v: unknown) => (typeof v === 'string' ? v : '');
	const num = (v: unknown, otherwise: number) => (typeof v === 'number' && Number.isFinite(v) ? v : otherwise);
	const target = (r.target ?? {}) as Record<string, unknown>;
	const window = (r.window ?? {}) as Record<string, unknown>;
	const parent = r.parent as Record<string, unknown> | undefined;
	const startLine = Math.max(1, num(target.startLine, 1));
	return {
		id: r.id,
		to: r.to,
		path: str(r.path),
		language: str(r.language),
		question: str(r.question),
		target: { startLine, endLine: Math.max(startLine, num(target.endLine, startLine)), text: str(target.text) },
		word: str(r.word),
		text: str(r.text),
		window: { first: Math.max(1, num(window.first, 1)), text: str(window.text) },
		...(parent && typeof parent.answer === 'string' ? { parent: { question: str(parent.question), answer: parent.answer } } : {}),
		notesDir: str(r.notesDir),
		deeper: r.deeper === true,
		cancel: r.cancel === true,
	};
}

/** True for a folder the editor may keep notes in: absolute, under `.symbiosis/notes`, no `..`. */
export function isNotesDir(dir: string): boolean {
	return dir.startsWith('/') && /\/\.symbiosis\/notes(\/|$)/.test(dir) && !dir.split('/').includes('..');
}

export const ASK_SYSTEM = `You explain code to a developer who reads it in an editor. They ask about one piece of code, with no comment in the file. Answer at once, with no preamble.

Write 2 to 4 short lines of plain text (at most 80 characters each) about THIS code: what it does and why it is there, not what the language feature is in general. Use \`backticks\` for names. No Markdown headings, no lists, no code fences. If the developer wrote a question, answer that question first.

Then end with two sections, each starting with its own line:

links:
- <title> | <where>
terms:
- <term>

links: one to three. <where> is either a place in this project as \`path:line\` (best: use the file and line numbers you were shown), or a URL to documentation or source. Give a URL only when you are sure it exists; do not guess. Give at least one link.

terms: two to five words or names in the code or your answer that the developer may want explained next, one per line, each at most 40 characters.

When the message says the developer wants a deeper answer, write up to 8 lines and cover what you left out before. When it says the developer drills down into a term, answer about that term in the context of this code, using the earlier answer.`;

/** The text of lines `from`..`to` (1-based, inclusive) of `text`. */
function lines(text: string, from: number, to: number): string {
	return text
		.split('\n')
		.slice(from - 1, to)
		.join('\n');
}

/** The innermost function that holds `line`. */
function enclosing(outline: Outline | undefined, line: number): Fn | undefined {
	let best: Fn | undefined;
	for (const fn of outline?.functions ?? []) {
		if (fn.line <= line && line <= fn.endLine && (!best || fn.line >= best.line)) best = fn;
	}
	return best;
}

export interface AskContext {
	/** The file's outline, when it parses. */
	outline?: Outline;
	plan: Step[];
	/** The agent's reasons for its changes to this file in its last turn. */
	whys: string[];
	cwd: string;
}

/** The user message of the side call: the code asked about and what surrounds it. */
export function askPrompt(req: AskRequest, ctx: AskContext): string {
	const path = req.path ? relative(ctx.cwd, req.path) || req.path : '(unsaved file)';
	const parts = [`File: ${path}${req.language ? ` (${req.language})` : ''}`];
	const imports = [...new Set((ctx.outline?.imports ?? []).map((i) => i.spec))].slice(0, IMPORTS_MAX);
	if (imports.length > 0) parts.push(`The file imports: ${imports.join(', ')}`);

	// The text the lines come from: the whole file, or the window the plugin sent.
	const source = req.text !== '' ? { first: 1, text: req.text } : req.window;
	const sourceLast = source.first + source.text.split('\n').length - 1;
	const fn = req.text !== '' ? enclosing(ctx.outline, req.target.startLine) : undefined;
	if (fn) {
		const last = Math.min(fn.endLine, fn.line + FUNCTION_MAX - 1);
		const cut = last < fn.endLine ? ` (the first ${FUNCTION_MAX} lines)` : '';
		parts.push(`The function around it${fn.name ? `, \`${fn.name}\`` : ''}, lines ${fn.line}-${fn.endLine}${cut}:\n${numbered(lines(source.text, fn.line - source.first + 1, last - source.first + 1), fn.line)}`);
		if (fn.intent) parts.push(`Its doc: ${fn.intent.trim()}`);
		if (fn.stub) {
			const signature = req.text.slice(fn.signature.start, fn.signature.end).replace(/\s+/g, ' ').trim();
			parts.push(`The developer left this function as a stub for the coding agent (signature: ${signature}).`);
		}
	} else {
		const from = Math.max(source.first, req.target.startLine - AROUND);
		const to = Math.min(sourceLast, req.target.endLine + AROUND);
		parts.push(`The code around it, lines ${from}-${to}:\n${numbered(lines(source.text, from - source.first + 1, to - source.first + 1), from)}`);
	}

	const where = req.target.startLine === req.target.endLine ? `line ${req.target.startLine}` : `lines ${req.target.startLine}-${req.target.endLine}`;
	parts.push(`The developer asks about ${where}:\n\`\`\`\n${req.target.text}\n\`\`\``);
	if (req.word) parts.push(`The symbol under the cursor: \`${req.word}\``);
	if (req.question.trim()) parts.push(`Their question: ${req.question.trim()}`);
	if (ctx.whys.length > 0) {
		parts.push(`The coding agent changed this file in its last turn. Its reasons, in its words:\n${ctx.whys.map((w) => `- ${w}`).join('\n')}`);
	}
	if (ctx.plan.length > 0) parts.push(`The agent's plan:\n${ctx.plan.map((s) => `- [${s.state}] ${s.text}`).join('\n')}`);
	if (req.parent) {
		parts.push(`The developer drills down into a term of an earlier answer.\nEarlier question: ${req.parent.question.trim() || '(explain this code)'}\nEarlier answer:\n${req.parent.answer.trim()}`);
	}
	if (req.deeper) parts.push('The developer wants a deeper answer to the same question.');
	return parts.join('\n\n');
}

export interface AskAnswer {
	/** The lines to read. */
	text: string;
	links: Link[];
	terms: string[];
}

const SECTION = /^\s*(links|terms)\s*:\s*$/i;
const SECTION_WORDS = ['links:', 'terms:'];

/** `path:line` in the project, with no scheme: `core/ask.ts:12`, `./a.go:3`. */
const FILE_LINK = /^(?:\.\/)?[\w@.+/-]+:\d+(?:-\d+)?$/;
const URL_LINK = /^https?:\/\/\S+$/i;

/** One `- title | where` line as a link, or undefined for anything else. */
function parseLink(line: string): Link | undefined {
	const item = line.replace(/^\s*[-*]\s*/, '');
	const bar = item.lastIndexOf('|');
	const title = (bar < 0 ? item : item.slice(0, bar)).trim();
	const where = (bar < 0 ? item : item.slice(bar + 1)).trim().replace(/^<|>$/g, '').replace(/^`|`$/g, '');
	if (URL_LINK.test(where)) return { title: bar < 0 ? where : title, target: where, kind: 'url' };
	if (FILE_LINK.test(where)) return { title: bar < 0 ? where : title, target: where.replace(/^\.\//, ''), kind: 'file' };
	return undefined;
}

/**
 * The answer so far, from all the model wrote (`raw`). Called on every delta.
 * `final`: the model is done; the last line is complete.
 */
export function parseAskAnswer(raw: string, final: boolean): AskAnswer {
	const all = raw.split('\n');
	const text: string[] = [];
	const links: Link[] = [];
	const terms: string[] = [];
	let section: 'text' | 'links' | 'terms' = 'text';
	for (let i = 0; i < all.length; i++) {
		const line = all[i] ?? '';
		const open = i === all.length - 1 && !final;
		const head = SECTION.exec(line);
		// A last line that may still become a section head waits for its end.
		if (open && section === 'text' && line.trim() !== '' && SECTION_WORDS.some((w) => w.startsWith(line.trim().toLowerCase()))) continue;
		if (head && !open) {
			section = head[1]!.toLowerCase() as 'links' | 'terms';
			continue;
		}
		if (section === 'text') text.push(line);
		else if (open) continue;
		else if (section === 'links') {
			const link = parseLink(line);
			if (link && links.length < LINKS_MAX) links.push(link);
		} else {
			const term = line
				.replace(/^\s*[-*]\s*/, '')
				.replace(/^`|`$/g, '')
				.trim();
			if (term && term.length <= TERM_MAX_CHARS && terms.length < TERMS_MAX && !terms.includes(term)) terms.push(term);
		}
	}
	return { text: text.join('\n').replace(/^(\s*\n)+/, '').replace(/\s+$/, ''), links, terms };
}
