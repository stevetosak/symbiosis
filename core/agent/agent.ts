import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { absolutePath } from '../call.ts';
import type { Channel } from '../channel/channel.ts';
import { FileChannel, pluginDir } from '../channel/file.ts';
import { type Capability, type ChannelEvent, type PluginState, PROTOCOL, type Session, type Tool } from '../protocol.ts';
import { paneOf } from '../session.ts';
import { adler32, BEFORE_MAX, FLUSH_MS, Tracker } from '../stream.ts';
import { Changes } from './changes.ts';
import { ChangeLog } from './changelog.ts';

/** The files a session record lists as written by it. */
const MAX_FILES = 20;

export interface AgentHost {
	stop(): void;
	quit(): void;
}

export interface AgentOptions {
	id: string;
	agent: string;
	can: Capability[];
	cwd: string;
	pid: number;
	host: AgentHost;
	env?: NodeJS.ProcessEnv;
	dir?: string;
}

interface Live {
	tracker: Tracker;
	args: Record<string, unknown>;
	timer?: ReturnType<typeof setTimeout>;
	last: number;
}

export class AgentSide {
	readonly id: string;
	readonly channel: Channel;
	readonly changes: Changes;
	readonly changeLog: ChangeLog;
	readonly record: Session;
	private readonly host: AgentHost;
	// The write and edit calls the agent streams now, by call id.
	private readonly live = new Map<string, Live>();
	// The run (turn start to turn end) whose changes are kept, and the run now.
	private changesRun = 0;
	private run = 0;
	private last: { path: string; line: number } | undefined;
	private state: PluginState = { alive: false, scope: 'stub' };
	private stateAt = 0;
	private lastStop: string | undefined;
	private lastClose: string | undefined;
	private begun = false;
	private ticks = 0;

	constructor(options: AgentOptions) {
		const dir = options.dir ?? pluginDir();
		this.id = options.id;
		this.host = options.host;
		this.channel = new FileChannel(dir);
		this.changes = new Changes(join(dir, 'changes'));
		this.changeLog = new ChangeLog(join(dir, 'log'), options.id);
		this.record = {
			id: options.id,
			agent: options.agent,
			can: [...options.can],
			version: PROTOCOL,
			...paneOf(options.env ?? process.env),
			model: null,
			waiting: null,
			cwd: options.cwd,
			name: basename(options.cwd),
			pid: options.pid,
			t: 0,
			active: 0,
			working: false,
			plan: [],
			files: [],
			title: null,
			fill: null,
			review: [],
		};
	}

	beat(): void {
		this.record.t = Date.now() / 1000;
		try {
			this.channel.writeSession(this.record);
		} catch {
			// A missed heartbeat is not worth failing a turn for.
		}
	}

	/** The plugin's state, read at most every 200 ms: tool calls can come in bursts. */
	plugin(): PluginState {
		if (Date.now() - this.stateAt > 200) {
			this.state = this.channel.plugin();
			this.stateAt = Date.now();
		}
		return this.state;
	}

	/** True when the editor follows this session: only then does it write events. */
	owner(): boolean {
		if (!this.channel.enabled()) return false;
		const p = this.plugin();
		return p.alive && p.owner === this.id;
	}

	/** The session starts in `cwd`. A stop or close request from before it is old. */
	begin(cwd: string): void {
		this.record.cwd = cwd;
		this.record.name = basename(cwd);
		this.record.active = Date.now() / 1000;
		this.lastStop = this.channel.enabled() ? this.channel.stop()?.id : undefined;
		this.lastClose = this.channel.enabled() ? this.channel.close()?.id : undefined;
		if (this.channel.enabled()) this.channel.pruneSessions();
		this.begun = true;
	}

	/** Every 100 ms: the editor's stop and close requests; a beat each second. */
	poll(): void {
		this.checkStop();
		this.checkClose();
		if (++this.ticks % 10 === 0) this.beat();
	}

	end(): void {
		this.channel.removeSession(this.id);
	}

	turnStart(): void {
		this.record.active = Date.now() / 1000;
		this.record.working = true;
		this.run = Date.now();
		this.beat();
		if (this.owner()) this.channel.rotate();
	}

	turnEnd(): void {
		this.record.working = false;
		this.beat();
		if (!this.channel.enabled()) return;
		this.abortOpen();
		if (this.last && this.owner()) this.channel.emit({ op: 'stop', ...this.last });
	}

	/** The agent writes a call's arguments: they go to the editor as they grow, at most once per FLUSH_MS. Only the owner streams. */
	stream(call: string, tool: Tool, args: Record<string, unknown>, cwd: string, final: boolean): void {
		if (!this.channel.enabled()) return;
		let entry = this.live.get(call);
		if (!entry) {
			if (!this.owner()) return;
			entry = { tracker: new Tracker(call, tool), args: {}, last: 0 };
			this.live.set(call, entry);
		}
		entry.args = args;
		const due = Date.now() - entry.last >= FLUSH_MS;
		if (final || due) this.flush(entry, cwd, final);
		else if (!entry.timer) {
			const pending = entry;
			pending.timer = setTimeout(() => this.flush(pending, cwd, false), FLUSH_MS);
		}
	}

	blocked(call: string, reason: string): void {
		const entry = this.live.get(call);
		this.live.delete(call);
		if (entry) clearTimeout(entry.timer);
		if (entry?.tracker.started) this.channel.emit({ op: 'abort', call, reason });
	}

	/** Just before the call runs: its final text and `ready`. The agent never waits for the editor. */
	ready(call: string, tool: Tool, args: Record<string, unknown>, cwd: string): void {
		if (!this.channel.enabled()) return;
		const target = args.path;
		if (typeof target !== 'string' || target === '') return;
		const path = absolutePath(target, cwd);
		this.wrote(path);
		this.keepBefore(path);
		this.safely(() => this.changeLog.before(call, path));
		let entry = this.live.get(call);
		if (!entry) {
			if (!this.owner()) return;
			entry = { tracker: new Tracker(call, tool), args: {}, last: 0 };
			this.live.set(call, entry);
		}
		entry.args = args;
		this.flush(entry, cwd, true);
		if (entry.tracker.started) {
			entry.tracker.readied = true;
			this.channel.emit({ op: 'ready', call });
		}
	}

	done(call: string, tool: Tool, args: Record<string, unknown>, cwd: string, ok: boolean, line: number, why?: string): void {
		const entry = this.live.get(call);
		if (entry) clearTimeout(entry.timer);
		const streamed = this.live.delete(call);
		if (!this.channel.enabled()) return;
		const target = args.path;
		if (typeof target !== 'string' || target === '') return;
		const path = absolutePath(target, cwd);
		if (!ok) this.changeLog.drop(call);
		else this.safely(() => this.changeLog.after(call, tool, path, this.record.plan, why));
		if (this.changesRun === this.run) this.safely(() => this.changes.after(path, why));
		if (!streamed && !this.owner()) return;
		const done = { op: 'done' as const, call, tool, path, line, ok, sum: sumOf(path), ...(why ? { why } : {}) };
		if (done.ok) this.last = { path: done.path, line: done.line };
		this.channel.emit(done);
	}

	/**
	 * The calls still open at the end of a turn got no result: the model
	 * stopped, or the agent skipped the tool. The editor drops their preview and their
	 * open count. Each tool result of a turn comes before its end.
	 */
	abortOpen(): void {
		for (const [call, entry] of this.live) {
			clearTimeout(entry.timer);
			if (entry.tracker.started && this.channel.enabled()) this.channel.emit({ op: 'abort', call });
		}
		this.live.clear();
	}

	/** The agent writes `path`: the editor follows this session for it. Beats at once,
	 * so the session record has the file before the editor opens it. */
	private wrote(path: string): void {
		if (this.record.files[this.record.files.length - 1] === path) return;
		this.record.files = [...this.record.files.filter((p) => p !== path), path].slice(-MAX_FILES);
		this.beat();
	}

	/** ctrl+k q in ttt: stop this session's turn. */
	private checkStop(): void {
		if (!this.begun || !this.channel.enabled()) return;
		const request = this.channel.stop();
		if (!request || request.to !== this.id || request.id === this.lastStop) return;
		this.lastStop = request.id;
		this.host.stop();
	}

	/** `symbiosis close`: this session quits. */
	private checkClose(): void {
		if (!this.begun || !this.channel.enabled()) return;
		const request = this.channel.close();
		if (!request || request.to !== this.id || request.id === this.lastClose) return;
		this.lastClose = request.id;
		this.host.quit();
	}

	/** Sends what changed since the last flush, starting the call once its path is complete. */
	private flush(entry: Live, cwd: string, final: boolean): void {
		clearTimeout(entry.timer);
		entry.timer = undefined;
		entry.last = Date.now();
		const t = entry.tracker;
		const events: ChannelEvent[] = [];
		if (!t.started) {
			const path = t.pathOf(entry.args, final);
			if (!path) return;
			t.path = absolutePath(path, cwd);
			t.started = true;
			this.wrote(t.path);
			events.push({ op: 'start', call: t.id, tool: t.tool, path: t.path, ...onDisk(t.path) });
		}
		events.push(...t.update(entry.args, final));
		this.channel.emit(...events);
	}

	/** For ctrl+k w in ttt: the file's text before this run first changes it. Owner only. */
	private keepBefore(path: string): void {
		if (!this.owner()) return;
		this.safely(() => {
			if (this.changesRun !== this.run) {
				this.changes.start(this.id);
				this.changesRun = this.run;
			}
			this.changes.before(path);
		});
	}

	/** A failure to keep a diff must not fail the tool call. */
	private safely(f: () => void): void {
		try {
			f();
		} catch {
			// The diff key shows less; the work goes on.
		}
	}
}

function sumOf(path: string): number | null {
	return existsSync(path) ? adler32(readFileSync(path)) : null;
}

/** The file now: its sum, and its text when it is not too big. */
function onDisk(path: string): { sum: number | null; before?: string } {
	if (!existsSync(path)) return { sum: null };
	const bytes = readFileSync(path);
	return bytes.length <= BEFORE_MAX ? { sum: adler32(bytes), before: bytes.toString('utf-8') } : { sum: adler32(bytes) };
}
