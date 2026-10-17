// The file channel between pi and the ttt plugin, in the plugin's own folder.
// A ttt plugin cannot reach localhost, so files are the only way in. It
// implements the Channel interface (./channel.ts).
//
//   events.jsonl  pi appends one ChannelEvent per line.
//   head.json     {gen, size}: the plugin reads this small file on every tick
//                 and reads events.jsonl only when it grew. A new `gen` means
//                 pi started the log again from empty.
//   ttt.json      {t, pinned, owner, lag, scope}: the plugin's heartbeat,
//                 every second. `owner` is the id of the session the editor
//                 follows; only that session writes events. `lag` is how many
//                 changes pi may make before the editor has shown them.
//                 `scope` is how far the guard lets a fill reach.
//   ack.json      [call ids]: the changes the editor has shown (replayed).
//   ask.json      AskRequest: the plugin asks session `to` about code
//                 (core/ask.ts), or to stop the answer (`cancel`).
//   review.json   {id, to, ack}: the plugin acks filled body `ack` of session
//                 `to` (core/review.ts).
//   help.json     HelpRequest: the plugin asks session `to` a helpi!
//                 question (core/help.ts), or to stop it (`cancel`).
//   stop.json     {id, to}: the plugin asks session `to` to stop its turn
//                 (ctrl+k q); `id` is new for each press.
//   fill.json     FillRequest: fill the stub at a line, or end the fill.
//   answer.json   ProposalAnswer: the developer accepts or rejects a proposal.
//   sessions/<id>.json  one Session per running pi, written every second.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseAskRequest } from '../ask.ts';
import { parseRequest } from '../help.ts';
import { parseReviewRequest, type ReviewRequest } from '../review.ts';
import { type AskRequest, type ChannelEvent, DEFAULT_LAG, FILL_MODES, type FillRequest, type HelpRequest, type PluginState, type ProposalAnswer, SCOPES, type Scope, type Session, type StopRequest } from '../protocol.ts';
import type { Channel } from './channel.ts';

/** The log starts again from empty at the start of a turn once it is this big. */
const ROTATE_BYTES = 256 * 1024;

/** The plugin's folder: a ttt plugin can read only there and in the workspace. */
export function pluginDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.TTT_CONFIG_DIR || join(home, '.config', 'ttt'), 'plugins', 'symbiosis');
}

export class FileChannel implements Channel {
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
		const state = readJson<{ t?: unknown; pinned?: unknown; owner?: unknown; lag?: unknown; scope?: unknown }>(join(this.dir, 'ttt.json'));
		const t = typeof state?.t === 'number' ? state.t : 0;
		const owner = typeof state?.owner === 'string' ? state.owner : undefined;
		const lag = typeof state?.lag === 'number' && Number.isInteger(state.lag) && state.lag >= -1 ? state.lag : DEFAULT_LAG;
		const alive = this.now() / 1000 - t < 3;
		// A scope from an editor that is gone does not hold: the strict default does.
		const scope: Scope = alive && SCOPES.includes(state?.scope as Scope) ? (state?.scope as Scope) : 'stub';
		return { alive, pinned: state?.pinned === true, lag, scope, ...(owner ? { owner } : {}) };
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
		return this.unshown([call]).length === 0;
	}

	/** The calls of `calls` that the editor has not shown yet. */
	unshown(calls: string[]): string[] {
		const acks = readJson<unknown[]>(join(this.dir, 'ack.json'));
		const shown = new Set(Array.isArray(acks) ? acks : []);
		return calls.filter((c) => !shown.has(c));
	}

	/** The plugin's last stop request, if any. */
	stop(): StopRequest | undefined {
		const raw = readJson<{ id?: unknown; to?: unknown }>(join(this.dir, 'stop.json'));
		return typeof raw?.id === 'string' && typeof raw.to === 'string' ? { id: raw.id, to: raw.to } : undefined;
	}

	/** The plugin's last helpi! request, if any. */
	help(): HelpRequest | undefined {
		return parseRequest(readJson(join(this.dir, 'help.json')));
	}

	/** The plugin's last ask request, if any. */
	ask(): AskRequest | undefined {
		return parseAskRequest(readJson(join(this.dir, 'ask.json')));
	}

	/** The plugin's last fill! request, if any. */
	fill(): FillRequest | undefined {
		const raw = readJson<Record<string, unknown>>(join(this.dir, 'fill.json'));
		if (typeof raw?.id !== 'string' || typeof raw.to !== 'string') return undefined;
		if (raw.release === true) return { id: raw.id, to: raw.to, release: true };
		if (typeof raw.path !== 'string' || typeof raw.line !== 'number') return undefined;
		const mode = FILL_MODES.find((m) => m === raw.mode) ?? 'stub';
		return { id: raw.id, to: raw.to, release: false, mode, path: raw.path, line: raw.line };
	}

	/** The plugin's last ack of a filled body, if any. */
	review(): ReviewRequest | undefined {
		return parseReviewRequest(readJson(join(this.dir, 'review.json')));
	}

	/** The plugin's last answer to a proposal, if any. */
	answer(): ProposalAnswer | undefined {
		const raw = readJson<Record<string, unknown>>(join(this.dir, 'answer.json'));
		if (typeof raw?.id !== 'string' || typeof raw.accept !== 'boolean') return undefined;
		return { id: raw.id, accept: raw.accept, note: typeof raw.note === 'string' ? raw.note.trim() : '' };
	}

	/**
	 * Waits until the editor has shown `call` (the plugin typed it at the
	 * operator's speed). There is no time limit: it waits as long as
	 * `waiting()` is true, which is the caller's check that the plugin still
	 * lives, still follows this session, and the turn was not aborted.
	 */
	async waitAck(call: string, waiting: () => boolean, stepMs = 20): Promise<boolean> {
		return (await this.waitBehind([call], 0, waiting, stepMs)).length === 0;
	}

	/**
	 * Waits until at most `limit` of `calls` are not shown yet (-1: no limit,
	 * no wait), or until `waiting()` is false. Returns the calls not shown yet.
	 */
	async waitBehind(calls: string[], limit: number, waiting: () => boolean, stepMs = 20): Promise<string[]> {
		let left = this.unshown(calls);
		while (limit >= 0 && left.length > limit && waiting()) {
			await new Promise((r) => setTimeout(r, stepMs));
			left = this.unshown(left);
		}
		return left;
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
