// The file channel between pi and the ttt plugin, in the plugin's own folder.
// A ttt plugin cannot reach localhost, so files are the only way in.
//
//   events.jsonl  pi appends one ChannelEvent per line.
//   head.json     {gen, size}: the plugin reads this small file on every tick
//                 and reads events.jsonl only when it grew. A new `gen` means
//                 pi started the log again from empty.
//   ttt.json      {t, pinned}: the plugin's heartbeat, every second.
//   ack.json      [call ids]: the previews the plugin has undone.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChannelEvent } from './stream.ts';

/** The log starts again from empty at the start of a turn once it is this big. */
const ROTATE_BYTES = 256 * 1024;

export interface PluginState {
	alive: boolean;
	pinned: boolean;
}

export class Channel {
	private gen = 0;
	private size = 0;

	readonly dir: string;
	private readonly now: () => number;

	constructor(dir: string, now: () => number = Date.now) {
		this.dir = dir;
		this.now = now;
	}

	/** False when ttt or the plugin is not installed: then pi writes nothing. */
	enabled(): boolean {
		return existsSync(this.dir);
	}

	/** Starts the log again from empty. */
	reset(): void {
		if (!this.enabled()) return;
		this.gen = this.now();
		this.size = 0;
		writeFileSync(join(this.dir, 'events.jsonl'), '');
		this.writeHead();
	}

	/** At the start of a turn: the plugin has read everything by then. */
	rotate(): void {
		if (this.gen === 0 || this.size > ROTATE_BYTES) this.reset();
	}

	emit(...events: ChannelEvent[]): void {
		if (!this.enabled() || events.length === 0) return;
		if (this.gen === 0) this.reset();
		const text = events.map((e) => `${JSON.stringify(e)}\n`).join('');
		appendFileSync(join(this.dir, 'events.jsonl'), text);
		this.size += Buffer.byteLength(text);
		this.writeHead();
	}

	plugin(): PluginState {
		const state = readJson<{ t?: unknown; pinned?: unknown }>(join(this.dir, 'ttt.json'));
		const t = typeof state?.t === 'number' ? state.t : 0;
		return { alive: this.now() / 1000 - t < 3, pinned: state?.pinned === true };
	}

	acked(call: string): boolean {
		const acks = readJson<unknown[]>(join(this.dir, 'ack.json'));
		return Array.isArray(acks) && acks.includes(call);
	}

	/** Waits until the plugin has undone the preview of `call`, or the timeout passes. True when it did. */
	async waitAck(call: string, timeoutMs = 1500, stepMs = 20): Promise<boolean> {
		const end = this.now() + timeoutMs;
		while (this.now() < end) {
			if (this.acked(call)) return true;
			await new Promise((r) => setTimeout(r, stepMs));
		}
		return this.acked(call);
	}

	private writeHead(): void {
		// Write then rename, so the plugin never reads half a file.
		const head = join(this.dir, 'head.json');
		const temporary = `${head}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify({ gen: this.gen, size: this.size }));
		renameSync(temporary, head);
	}
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as T;
	} catch {
		return undefined;
	}
}
