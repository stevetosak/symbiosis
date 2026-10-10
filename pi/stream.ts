// What pi tells the editor, as events. Pure, so the tests need no pi and no ttt.
//
// The model streams the arguments of a `write` or `edit` call; pi parses the
// partial JSON on every delta. A Tracker turns those growing arguments into
// small `text` events: "the value of <key> is now its first <from> bytes,
// then <text>". The ttt plugin applies them to the buffer as a preview, undoes
// the preview just before the tool writes (`ready`), and follows the result
// (`done`, `stop`). See docs/design.md.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export type Tool = 'write' | 'edit';

export type ChannelEvent =
	/** A call starts streaming. `sum` is the Adler-32 of the file on disk, null when it does not exist. */
	| { op: 'start'; call: string; tool: Tool; path: string; sum: number | null }
	/** `key` is `content`, `edits.<i>.old` (sent once, complete) or `edits.<i>.new`. `from` counts UTF-8 bytes. */
	| { op: 'text'; call: string; key: string; from: number; text: string }
	/** The tool is about to run: undo the preview, then acknowledge. */
	| { op: 'ready'; call: string }
	/** The call will not run (the turn ended without it): undo the preview. */
	| { op: 'abort'; call: string }
	/** The tool ran. `line` is the first changed line. */
	| { op: 'done'; call: string; tool: Tool; path: string; line: number; ok: boolean }
	/** The agent's turn ended; the editor goes to the last edit even when pinned. */
	| { op: 'stop'; path: string; line: number };

export interface EditArg {
	oldText?: unknown;
	newText?: unknown;
}

/** Streams one tool call. Remembers what it sent, so each update sends only the change. */
export class Tracker {
	readonly sent = new Map<string, string>();
	path: string | undefined;
	started = false;
	readied = false;

	readonly id: string;
	readonly tool: Tool;

	constructor(id: string, tool: Tool) {
		this.id = id;
		this.tool = tool;
	}

	/**
	 * The path once it is complete: the model writes `path` first, so it is
	 * complete when a later key exists, or when the arguments are final.
	 */
	pathOf(args: Record<string, unknown>, final: boolean): string | undefined {
		const later = this.tool === 'write' ? 'content' in args : 'edits' in args;
		return typeof args.path === 'string' && args.path !== '' && (later || final) ? args.path : undefined;
	}

	/** The string values to show, by key. An oldText is shown only once it is complete. */
	values(args: Record<string, unknown>, final: boolean): [string, string][] {
		if (this.tool === 'write') return typeof args.content === 'string' ? [['content', args.content]] : [];
		const edits = Array.isArray(args.edits) ? (args.edits as EditArg[]) : [];
		const out: [string, string][] = [];
		edits.forEach((edit, i) => {
			if (!edit || typeof edit !== 'object' || typeof edit.oldText !== 'string') return;
			const complete = final || 'newText' in edit || i < edits.length - 1;
			if (!complete) return;
			out.push([`edits.${i}.old`, edit.oldText]);
			if (typeof edit.newText === 'string') out.push([`edits.${i}.new`, edit.newText]);
		});
		return out;
	}

	/** The text events for these arguments. An oldText is sent once: it does not change after it is complete. */
	update(args: Record<string, unknown>, final = false): Extract<ChannelEvent, { op: 'text' }>[] {
		const events: Extract<ChannelEvent, { op: 'text' }>[] = [];
		for (const [key, value] of this.values(args, final)) {
			const before = this.sent.get(key);
			if (before === value) continue;
			if (before !== undefined && key.endsWith('.old')) continue;
			const p = before === undefined ? 0 : commonPrefix(before, value);
			events.push({ call: this.id, op: 'text', key, from: utf8Bytes(value.slice(0, p)), text: value.slice(p) });
			this.sent.set(key, value);
		}
		return events;
	}
}

/** The length, in UTF-16 units, of the common prefix, never splitting a surrogate pair. */
export function commonPrefix(a: string, b: string): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
	if (i > 0 && i < b.length && isHighSurrogate(b.charCodeAt(i - 1))) i--;
	return i;
}

function isHighSurrogate(code: number): boolean {
	return code >= 0xd800 && code <= 0xdbff;
}

export function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, 'utf-8');
}

/** Adler-32 over the bytes: the ttt plugin computes the same over its buffer, to see unsaved changes. */
export function adler32(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (const byte of bytes) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return b * 65536 + a;
}

/** The absolute path a tool call names: `~/` is the home folder, a relative path is from cwd. */
export function absolutePath(path: string, cwd: string, home = homedir()): string {
	if (path === '~' || path.startsWith('~/')) return join(home, path.slice(1));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/** The first changed line of a tool result: pi's edit reports it, a write starts at line 1. */
export function firstLine(tool: Tool, details: unknown): number {
	const first = (details as { firstChangedLine?: unknown } | undefined)?.firstChangedLine;
	return tool === 'edit' && typeof first === 'number' && first > 0 ? first : 1;
}

/** The plugin's folder: a ttt plugin can read only there and in the workspace. */
export function pluginDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.TTT_CONFIG_DIR || join(home, '.config', 'ttt'), 'plugins', 'symbiosis');
}
