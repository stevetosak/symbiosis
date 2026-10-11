// The file channel between pi and the ttt plugin, in the plugin's own folder.
// A ttt plugin cannot reach localhost, so files are the only way in.
//
//   events.jsonl  pi appends one ChannelEvent per line.
//   head.json     {gen, size}: the plugin reads this small file on every tick
//                 and reads events.jsonl only when it grew. A new `gen` means
//                 pi started the log again from empty.
//   ttt.json      {t, pinned, owner}: the plugin's heartbeat, every second.
//                 `owner` is the id of the session the editor follows; only
//                 that session writes events.
//   ack.json      [call ids]: the previews the plugin has undone.
//   request.json  {id, path, to}: the plugin asks session `to` to send the
//                 AI!/AI? markers.
//   sessions/<id>.json  one Session per running pi, written every second.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Step } from './plan.ts';
import type { ChannelEvent } from './stream.ts';

/** The log starts again from empty at the start of a turn once it is this big. */
const ROTATE_BYTES = 256 * 1024;

export interface PluginState {
	alive: boolean;
	pinned: boolean;
	/** The session the editor follows, if any. */
	owner?: string;
}

/** What a pi session tells the plugin about itself. Times are Unix seconds. */
export interface Session {
	id: string;
	/** The channel protocol of this extension; the plugin flags an older one. */
	version: number;
	/** The herdr pane of this pi, when it runs in herdr. */
	pane: string | null;
	cwd: string;
	name: string;
	pid: number;
	/** Heartbeat. */
	t: number;
	/** When the agent last started work. */
	active: number;
	working: boolean;
	/** pi's plan, shown as the timeline. Empty when pi has not sent one. */
	plan: Step[];
	/** The files this session wrote or edited, the last one last. The editor
	 * follows the session that wrote the open file. */
	files: string[];
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
		// Another session wrote the log since: start it again, so head.json and the log agree.
		if (this.gen === 0 || this.headGen() !== this.gen) this.reset();
		const text = events.map((e) => `${JSON.stringify(e)}\n`).join('');
		appendFileSync(join(this.dir, 'events.jsonl'), text);
		this.size += Buffer.byteLength(text);
		this.writeHead();
	}

	plugin(): PluginState {
		const state = readJson<{ t?: unknown; pinned?: unknown; owner?: unknown }>(join(this.dir, 'ttt.json'));
		const t = typeof state?.t === 'number' ? state.t : 0;
		const owner = typeof state?.owner === 'string' ? state.owner : undefined;
		return { alive: this.now() / 1000 - t < 3, pinned: state?.pinned === true, ...(owner ? { owner } : {}) };
	}

	/** Writes this session's record: the heartbeat the plugin reads. */
	writeSession(session: Session): void {
		if (!this.enabled()) return;
		const dir = join(this.dir, 'sessions');
		mkdirSync(dir, { recursive: true });
		atomicWrite(join(dir, `${session.id}.json`), JSON.stringify(session));
	}

	removeSession(id: string): void {
		rmSync(join(this.dir, 'sessions', `${id}.json`), { force: true });
	}

	/** Removes the records of sessions that stopped without saying so (a crash, a kill). */
	pruneSessions(maxAgeSeconds = 60): void {
		const dir = join(this.dir, 'sessions');
		if (!existsSync(dir)) return;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith('.json')) continue;
			const s = readJson<{ t?: unknown }>(join(dir, file));
			if (typeof s?.t !== 'number' || this.now() / 1000 - s.t > maxAgeSeconds) rmSync(join(dir, file), { force: true });
		}
	}

	acked(call: string): boolean {
		const acks = readJson<unknown[]>(join(this.dir, 'ack.json'));
		return Array.isArray(acks) && acks.includes(call);
	}

	/** The last send request of the plugin, if any. */
	request(): { id: string; path?: string; to?: string } | undefined {
		const r = readJson<{ id?: unknown; path?: unknown; to?: unknown }>(join(this.dir, 'request.json'));
		if (typeof r?.id !== 'string') return undefined;
		return {
			id: r.id,
			path: typeof r.path === 'string' && r.path !== '' ? r.path : undefined,
			to: typeof r.to === 'string' ? r.to : undefined,
		};
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

	private headGen(): number | undefined {
		const head = readJson<{ gen?: unknown }>(join(this.dir, 'head.json'));
		return typeof head?.gen === 'number' ? head.gen : undefined;
	}

	private writeHead(): void {
		atomicWrite(join(this.dir, 'head.json'), JSON.stringify({ gen: this.gen, size: this.size }));
	}
}

/** Write then rename, so the plugin never reads half a file. */
function atomicWrite(path: string, text: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, text);
	renameSync(temporary, path);
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf-8')) as T;
	} catch {
		return undefined;
	}
}
