// The typed preview, pi's side: the model streams the arguments of a `write`
// or `edit` call, and pi parses the partial JSON on every delta. A Tracker
// turns those growing arguments into small `text` events: "the value of <key>
// is now its first <from> bytes, then <text>". Pure, so the tests need no pi
// and no ttt. The plugin types them in the buffer at the operator's speed,
// behind pi: pi never waits for it. See docs/design.md, "The preview".
import type { ChannelEvent, Tool } from './protocol.ts';

export interface EditArg {
	oldText?: unknown;
	newText?: unknown;
}

export type TextEvent = Extract<ChannelEvent, { op: 'text' }>;

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

	/** The path once it is complete: a key after it exists, or the arguments are final. */
	pathOf(args: Record<string, unknown>, final: boolean): string | undefined {
		return typeof args.path === 'string' && args.path !== '' && (final || hasLaterKey(args, 'path')) ? args.path : undefined;
	}

	/** The string values to show, by key. An oldText is shown only once it is complete. */
	values(args: Record<string, unknown>, final: boolean): [string, string][] {
		if (this.tool === 'write') return typeof args.content === 'string' ? [['content', args.content]] : [];
		const edits = Array.isArray(args.edits) ? (args.edits as EditArg[]) : [];
		const out: [string, string][] = [];
		edits.forEach((edit, i) => {
			if (!edit || typeof edit !== 'object' || typeof edit.oldText !== 'string') return;
			const complete = final || i < edits.length - 1 || hasLaterKey(edit as Record<string, unknown>, 'oldText');
			if (!complete) return;
			out.push([`edits.${i}.old`, edit.oldText]);
			if (typeof edit.newText === 'string') out.push([`edits.${i}.new`, edit.newText]);
		});
		return out;
	}

	/** The text events for these arguments. An oldText is sent once: it does not change after it is complete. */
	update(args: Record<string, unknown>, final = false): TextEvent[] {
		const events: TextEvent[] = [];
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

/** The partial JSON parser keeps the keys in the order the model wrote them: a value is complete once a key follows it. */
function hasLaterKey(object: Record<string, unknown>, key: string): boolean {
	const keys = Object.keys(object);
	const at = keys.indexOf(key);
	return at >= 0 && at < keys.length - 1;
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

/** A file's text for a `start` event: up to this size. Bigger files get only the sum. */
export const BEFORE_MAX = 256 * 1024;

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
