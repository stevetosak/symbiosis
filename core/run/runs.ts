// The runs: one folder per run in the plugin folder, runs/<id>/, which the
// supervisor (launcher/run.ts) writes and the ttt plugin reads:
//
//   launch.json  what to start (core/run/list.ts Launch)
//   state.json   RunState; rewritten (atomically) as the run goes
//   output.log   all the output, as the program wrote it
//   tail.txt     the last TAIL_LINES lines, colours taken out: what the Run panel shows
//   stop         written by `run stop`: the run was stopped, not ended
//   keep         written when ttt quits and the user keeps the run going
//   session      the symbiosis (launcher) session whose ttt started or adopted the run
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { After } from './config.ts';
import type { Launch } from './list.ts';

export const TAIL_LINES = 2000;
export const HEARTBEAT_MS = 2000;
/** A new run is live this long before its supervisor says so. */
export const STARTING_MS = 10_000;
/** The longest line the tail keeps; the rest of it is cut. */
export const LINE_MAX = 4096;
/** Ended runs older than this go, whatever their folder. */
export const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

export type RunStatus = 'starting' | 'running' | 'exited' | 'stopped' | 'failed' | 'lost';

export interface RunState {
	readonly id: string;
	readonly name: string;
	readonly configId: string;
	readonly folder: string;
	readonly line: string;
	readonly cwd: string;
	readonly status: RunStatus;
	/** The program's pid; also its process group. */
	readonly pid?: number;
	/** The supervisor's pid. */
	readonly supervisor?: number;
	readonly started: number;
	readonly ended?: number;
	readonly code?: number;
	readonly signal?: string;
	readonly error?: string;
	/** Goes up when tail.txt changes. */
	readonly seq: number;
	/** The supervisor's heartbeat (ms), every HEARTBEAT_MS while the run runs. */
	readonly t?: number;
	readonly kept?: boolean;
	/** The symbiosis session (SYMBIOSIS_SESSION) the run belongs to; from the session file. */
	readonly session?: string;
	readonly compound?: string;
	readonly steps?: readonly { readonly name: string; readonly configId: string; readonly after?: After }[];
	readonly next?: number;
}

export function isLive(status: RunStatus): boolean {
	return status === 'starting' || status === 'running';
}

export function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

export function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

export function alive(pid: number | undefined): boolean {
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Whether any process of a process group is left. */
export function groupAlive(pgid: number | undefined): boolean {
	if (!pgid) return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** Signals a process group; its leader was spawned detached. */
export function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
	if (!pid) return;
	try {
		process.kill(-pid, signal);
	} catch {
		// gone
	}
}

export function newRunId(now = Date.now()): string {
	return `${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class Runs {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	path(id: string, file = ''): string {
		if (!/^[\w-]+$/.test(id)) throw new Error(`not a run id: ${id}`);
		return file ? join(this.dir, id, file) : join(this.dir, id);
	}

	create(launch: Launch, id = newRunId(), session?: string): RunState {
		mkdirSync(this.path(id), { recursive: true });
		if (session) this.own(id, session);
		writeFileSync(this.path(id, 'launch.json'), `${JSON.stringify(launch, null, 2)}\n`);
		writeFileSync(this.path(id, 'tail.txt'), '');
		const state: RunState = {
			id, name: launch.name, configId: launch.configId, folder: launch.folder, line: launch.line, cwd: launch.cwd,
			status: 'starting', started: Date.now(), seq: 0,
			...(launch.compound ? { compound: launch.compound } : {}),
			...(launch.steps ? {
				steps: launch.steps.map((s) => ({ name: s.launch.name, configId: s.launch.configId, ...(s.after ? { after: s.after } : {}) })),
				next: 0,
			} : {}),
		};
		this.write(state);
		return state;
	}

	write(state: RunState): void {
		writeAtomic(this.path(state.id, 'state.json'), `${JSON.stringify(state)}\n`);
	}

	read(id: string): RunState | undefined {
		const state = readJson<RunState>(this.path(id, 'state.json'));
		if (!state) return undefined;
		const kept = existsSync(this.path(id, 'keep'));
		let session: string | undefined;
		try {
			session = readFileSync(this.path(id, 'session'), 'utf8').trim() || undefined;
		} catch {
			// none
		}
		const extra = session ? { kept, session } : { kept };
		// A run whose supervisor is gone without a word (a crash, a reboot);
		// a new one waits a while for its supervisor to come up.
		const starting = state.status === 'starting' && !state.supervisor && Date.now() - state.started < STARTING_MS;
		if (isLive(state.status) && !starting && !alive(state.supervisor)) {
			return { ...state, status: 'lost', ...extra };
		}
		return { ...state, ...extra };
	}

	launch(id: string): Launch | undefined {
		return readJson<Launch>(this.path(id, 'launch.json'));
	}

	/** Every run, oldest first; with `folder`, only that workspace's. */
	list(folder?: string): RunState[] {
		let ids: string[] = [];
		try {
			ids = readdirSync(this.dir).filter((n) => /^[\w-]+$/.test(n));
		} catch {
			return [];
		}
		const out: RunState[] = [];
		for (const id of ids) {
			const s = this.read(id);
			if (s && (!folder || s.folder === folder)) out.push(s);
		}
		return out.sort((a, b) => a.started - b.started);
	}

	/** The run belongs to `session` now (ttt started it, or took it back). */
	own(id: string, session: string): void {
		writeFileSync(this.path(id, 'session'), `${session}\n`);
	}

	mark(id: string, marker: 'stop' | 'keep', on = true): void {
		if (on) writeFileSync(this.path(id, marker), `${Date.now()}\n`);
		else rmSync(this.path(id, marker), { force: true });
	}

	marked(id: string, marker: 'stop' | 'keep'): boolean {
		return existsSync(this.path(id, marker));
	}

	remove(id: string): void {
		rmSync(this.path(id), { recursive: true, force: true });
	}

	/** Removes the ended runs of `folder` past the newest `keep` ones. */
	prune(folder: string, keep = 10): string[] {
		const ended = this.list(folder).filter((s) => !isLive(s.status));
		const gone = ended.slice(0, Math.max(0, ended.length - keep)).map((s) => s.id);
		for (const id of gone) this.remove(id);
		return gone;
	}

	/** Removes the ended runs, of any folder, that ended before `maxAgeMs` ago. */
	pruneOld(maxAgeMs = MAX_AGE_MS, now = Date.now()): string[] {
		const gone = this.list().filter((s) => !isLive(s.status) && (s.ended ?? s.started) < now - maxAgeMs).map((s) => s.id);
		for (const id of gone) this.remove(id);
		return gone;
	}

	/** Bytes of output.log; for tests and the panel's "N lines" line. */
	size(id: string): number {
		try {
			return statSync(this.path(id, 'output.log')).size;
		} catch {
			return 0;
		}
	}
}

// The tail ----------------------------------------------------------------------

// CSI (colours, cursor moves), OSC (titles, links), and the other escapes.
const ANSI = /\x1b\[[0-?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI, '');
}

/**
 * The last lines of the output as a terminal shows them: colours out, a \r
 * starts the line over (progress bars), tabs as spaces, other control
 * characters dropped. Feed it chunks; a line may span them.
 */
export class Tail {
	private lines: string[] = [];
	private current = '';
	private pending = '';
	private cr = false;
	private total = 0;

	readonly max: number;

	constructor(max = TAIL_LINES) {
		this.max = max;
	}

	push(chunk: string): void {
		let text = this.pending + chunk;
		// An escape cut at the end of the chunk waits for the rest.
		const cut = text.lastIndexOf('\x1b');
		if (cut >= 0 && cut > text.length - 32 && !/^\x1b(\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)|[@-Z\\-_])/.test(text.slice(cut))) {
			this.pending = text.slice(cut);
			text = text.slice(0, cut);
		} else {
			this.pending = '';
		}
		text = stripAnsi(text);
		for (const ch of text) {
			// A \r goes back to the start of the line, unless a \n follows
			// (\r\n, maybe cut between two chunks).
			if (this.cr && ch !== '\n') this.current = '';
			this.cr = ch === '\r';
			if (ch === '\n') {
				this.lines.push(this.current);
				this.total++;
				this.current = '';
				if (this.lines.length >= 2 * this.max) this.lines.splice(0, this.lines.length - this.max);
			} else if (this.current.length >= LINE_MAX) {
				// A line with no end (minified output, a stuck progress bar): cut.
			} else if (ch === '\t') {
				this.current += ' '.repeat(4 - (this.current.length % 4));
			} else if (ch >= ' ' && ch !== '\x7f') {
				this.current += ch;
			}
		}
	}

	/** The lines, with the unfinished last one. */
	text(): string {
		const all = this.current === '' ? this.lines : [...this.lines, this.current];
		return all.length === 0 ? '' : `${all.slice(-this.max).join('\n')}\n`;
	}

	/** Lines ended so far, all of them (not only those kept). */
	count(): number {
		return this.total;
	}
}
