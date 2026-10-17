// `symbiosis run ...`: the run configurations, for the ttt plugin (which can
// start only the programs its manifest names, and cannot keep or kill them).
// Every command prints one JSON object on stdout: { ok: true, ... } or
// { ok: false, error }.
//
//   symbiosis run list  [--file F] [--folder D]          the configs and the runs of the workspace
//   symbiosis run start --folder D --config ID [--file F] [--line N]
//                       [--input ID=VALUE [--input-label ID=LABEL]]... [--ask]
//                       the config's inputs: those given, else picked as core/run/inputs.ts says;
//                       one the user is to pick: { ok: true, ask } and no run. --ask: the user picks each.
//                       Started: { ok: true, run, picked? }, picked = the labels of its inputs' picks.
//   symbiosis run again ID                               the same run again (stops it first if it runs)
//   symbiosis run stop  ID... | --folder D --all
//   symbiosis run ps    --folder D [--adopt]              the runs; --adopt: ttt is back, forget "keep"
//   symbiosis run keep  ID...                             ttt quits, the runs go on
//   symbiosis run remove ID...                            forgets ended runs (their output too)
//   symbiosis run save  --folder D --config ID            a detected config into .symbiosis/run.json
//   symbiosis run supervise ID                            (internal) runs the program, writes runs/ID
//
// --runs D or SYMBIOSIS_RUNS names the runs folder (default: runs/ in the
// plugin folder; the plugin always says which).
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { StringDecoder } from 'node:string_decoder';
import { pluginDir } from '../core/channel/file.ts';
import { parseJsonc, RunConfigError, toRunJson } from '../core/run/config.ts';
import { InputMemory, pickedLabels, pickInputs } from '../core/run/inputs.ts';
import { listConfigs, listed, resolveConfig, RUN_JSON, workspaceFolder } from '../core/run/list.ts';
import { readSmall } from '../core/run/providers/provider.ts';
import { alive, groupAlive, HEARTBEAT_MS, isLive, killGroup, type RunState, Runs, Tail, writeAtomic } from '../core/run/runs.ts';

export function runsDir(env: NodeJS.ProcessEnv = process.env): string {
	return env.SYMBIOSIS_RUNS || join(pluginDir(env), 'runs');
}

/** The inputs picked last: next to the runs folder (the plugin folder's run-inputs.json). */
export function inputMemory(runs: Runs): InputMemory {
	return new InputMemory(join(dirname(runs.dir), 'run-inputs.json'));
}

export interface RunArgs {
	readonly command: string;
	readonly ids: string[];
	readonly folder?: string;
	readonly file?: string;
	readonly line?: number;
	readonly config?: string;
	readonly runs?: string;
	readonly all: boolean;
	readonly adopt: boolean;
	/** --input ID=VALUE: the values of inputs, by id. */
	readonly inputs?: Readonly<Record<string, string>>;
	/** --input-label ID=LABEL: their labels, for the picker. */
	readonly labels?: Readonly<Record<string, string>>;
	/** --ask: the user picks every input not given. */
	readonly ask?: boolean;
}

export function parseRunArgs(argv: readonly string[]): RunArgs {
	const [command = 'help', ...rest] = argv;
	const out: { -readonly [K in keyof RunArgs]: RunArgs[K] } = { command, ids: [], all: false, adopt: false };
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		const value = () => {
			const v = rest[++i];
			if (v === undefined) throw new RunConfigError(`${a} needs a value`);
			return v;
		};
		if (a === '--folder') out.folder = resolve(value());
		else if (a === '--file') out.file = value() || undefined;
		else if (a === '--line') out.line = Number(value()) || undefined;
		else if (a === '--config') out.config = value();
		else if (a === '--runs') out.runs = resolve(value());
		else if (a === '--all') out.all = true;
		else if (a === '--adopt') out.adopt = true;
		else if (a === '--ask') out.ask = true;
		else if (a === '--input' || a === '--input-label') {
			const v = value();
			const eq = v.indexOf('=');
			if (eq <= 0) throw new RunConfigError(`${a} needs ID=VALUE, not "${v}"`);
			const key = a === '--input' ? 'inputs' : 'labels';
			out[key] = { ...out[key], [v.slice(0, eq)]: v.slice(eq + 1) };
		}
		else if (a.startsWith('--')) throw new RunConfigError(`unknown option ${a}`);
		else out.ids.push(a);
	}
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stops a run: the stop marker (a supervisor still starting reads it), SIGTERM
 * to the program's process group, SIGKILL to what is left of it after
 * `graceMs`; then waits for the supervisor's last word. Only the supervisor
 * writes the state of a run it watches; this writes it only when the
 * supervisor is gone.
 */
export async function stopRun(runs: Runs, id: string, graceMs = 4000): Promise<RunState | undefined> {
	let state = runs.read(id);
	if (!state || (!isLive(state.status) && state.status !== 'lost')) return state;
	runs.mark(id, 'stop');
	const began = Date.now();
	if (state.status === 'lost') {
		// No supervisor: its program may run on, but a pid this old may be
		// another program's now. Only a run that beat lately is still its own.
		if (state.pid && state.t && Date.now() - state.t < 3 * HEARTBEAT_MS && groupAlive(state.pid)) killGroup(state.pid, 'SIGKILL');
	} else {
		let termed: number | undefined;
		let killed = false;
		while (state && isLive(state.status) && Date.now() - began < graceMs + 3000) {
			if (state.pid && state.pid !== termed) {
				killGroup(state.pid, 'SIGTERM');
				termed = state.pid;
			} else if (termed && !killed && Date.now() - began >= graceMs && groupAlive(termed)) {
				killGroup(termed, 'SIGKILL');
				killed = true;
			}
			await sleep(50);
			state = runs.read(id);
		}
	}
	const now = runs.read(id);
	if (now && (isLive(now.status) || now.status === 'lost') && !alive(now.supervisor)) {
		const done = { ...now, status: 'stopped' as const, ended: Date.now() };
		runs.write(done);
		return done;
	}
	return now;
}

function launchSupervisor(runs: Runs, id: string): void {
	const child = spawn(process.execPath, [...process.execArgv, process.argv[1], 'run', 'supervise', id, '--runs', runs.dir], {
		detached: true,
		stdio: 'ignore',
		env: process.env,
	});
	child.unref();
}

/** output.log stops here; tail.txt goes on. */
const LOG_MAX = 64 * 1024 * 1024;

/** The supervisor: runs the program in its own process group, keeps runs/ID up to date. */
export async function supervise(runs: Runs, id: string): Promise<number> {
	const launch = runs.launch(id);
	let state = runs.read(id);
	if (!launch || !state) return 1;
	// Only state.json's own fields: kept and session come from their files.
	const { kept: _kept, session: _session, ...own } = state;
	state = { ...own, status: 'starting' };
	const write = (patch: Partial<RunState>) => {
		state = { ...state!, ...patch };
		runs.write(state);
	};
	write({ supervisor: process.pid, t: Date.now() });
	if (runs.marked(id, 'stop')) {
		// Stopped before it started.
		write({ status: 'stopped', ended: Date.now() });
		return 0;
	}
	const log = openSync(runs.path(id, 'output.log'), 'a');
	let logged = 0;
	const tail = new Tail();
	let dirty = false;
	const flush = () => {
		if (!dirty) return;
		dirty = false;
		writeAtomic(runs.path(id, 'tail.txt'), tail.text());
		write({ seq: state!.seq + 1 });
	};
	const hasArgs = launch.args !== undefined;
	const child = spawn(hasArgs ? launch.command : '/bin/sh', hasArgs ? [...launch.args!] : ['-c', launch.command], {
		cwd: launch.cwd,
		env: { ...process.env, ...launch.env },
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	// Whatever goes wrong here, the program does not run on unwatched.
	process.on('uncaughtException', (error) => {
		killGroup(child.pid, 'SIGKILL');
		try {
			write({ status: 'failed', ended: Date.now(), error: `symbiosis run: ${error.message}` });
		} catch {
			// the runs folder is gone
		}
		process.exit(1);
	});
	const timer = setInterval(flush, 200);
	// A heartbeat: the plugin cannot ask whether a pid lives; a run whose
	// state is not rewritten for a while has lost its supervisor.
	const beat = setInterval(() => write({ t: Date.now() }), HEARTBEAT_MS);
	for (const stream of [child.stdout, child.stderr]) {
		const decoder = new StringDecoder('utf8');
		stream?.on('data', (chunk: Buffer) => {
			if (logged < LOG_MAX) {
				try {
					writeSync(log, chunk);
				} catch {
					logged = LOG_MAX; // a full disk: the tail goes on
				}
				logged += chunk.length;
				if (logged >= LOG_MAX) {
					try {
						writeSync(log, `\n[symbiosis: output.log stops at ${LOG_MAX >> 20} MB; the Run panel shows the rest]\n`);
					} catch {
						// as above
					}
				}
			}
			tail.push(decoder.write(chunk));
			dirty = true;
		});
	}
	process.on('SIGHUP', () => {});
	process.on('SIGTERM', () => killGroup(child.pid, 'SIGTERM'));
	process.on('SIGINT', () => killGroup(child.pid, 'SIGINT'));

	const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((done) => {
		child.on('error', (error: NodeJS.ErrnoException) => {
			const why = error.code === 'ENOENT' ? `${launch.command}: command not found` : error.message;
			done({ code: null, signal: null, error: why });
		});
		child.on('spawn', () => {
			write({ status: 'running', pid: child.pid, t: Date.now() });
			// `run stop` came while it was starting, before it knew the pid.
			if (runs.marked(id, 'stop')) killGroup(child.pid, 'SIGTERM');
		});
		child.on('exit', (code, signal) => {
			// The pipes close when the last process that holds them ends; a
			// child the program left behind may hold them for good.
			let closed = false;
			child.on('close', () => {
				if (!closed) done({ code, signal });
				closed = true;
			});
			setTimeout(() => {
				if (!closed) done({ code, signal });
				closed = true;
			}, 500);
		});
	});
	clearInterval(timer);
	clearInterval(beat);
	if (result.error) {
		tail.push(`${result.error}\n`);
		dirty = true;
	}
	flush();
	closeSync(log);
	const stopped = runs.marked(id, 'stop');
	write({
		status: result.error ? 'failed' : stopped ? 'stopped' : 'exited',
		ended: Date.now(),
		...(result.code !== null ? { code: result.code } : {}),
		...(result.signal ? { signal: result.signal } : {}),
		...(result.error ? { error: result.error } : {}),
	});
	return 0;
}

function contextOf(args: RunArgs): { folder: string; file?: string } {
	const folder = args.folder ?? workspaceFolder(args.file, process.cwd());
	return { folder, ...(args.file ? { file: resolve(process.cwd(), args.file) } : {}) };
}

/** Runs a `symbiosis run` command; returns the JSON to print and the exit code. */
export async function runCommand(args: RunArgs, runs = new Runs(args.runs ?? runsDir())): Promise<{ out: Record<string, unknown>; code: number }> {
	const ok = (out: Record<string, unknown>) => ({ out: { ok: true, ...out }, code: 0 });
	switch (args.command) {
		case 'list': {
			const { folder, file } = contextOf(args);
			const listing = listConfigs(folder, { file });
			const memory = inputMemory(runs);
			return ok({
				folder,
				configs: listing.configs.map((c) => listed(folder, c, file, pickedLabels(c, folder, memory))),
				problems: listing.problems,
				runs: runs.list(folder),
			});
		}
		case 'start': {
			const { folder, file } = contextOf(args);
			if (!args.config) throw new RunConfigError('start needs --config');
			const config = listConfigs(folder, { file }).configs.find((c) => c.id === args.config);
			if (!config) throw new RunConfigError(`no configuration "${args.config}" in ${folder}`);
			const ctx = { folder, file, line: args.line, env: process.env };
			const memory = inputMemory(runs);
			const inputs = await pickInputs(config, ctx, memory, args.inputs, args.labels, args.ask);
			if ('ask' in inputs) return ok({ ask: inputs.ask });
			const launch = resolveConfig(config, { ...ctx, inputs: inputs.values });
			// One run per configuration, as in Rider: starting it again restarts it.
			for (const r of runs.list(folder)) {
				if (r.configId === config.id && isLive(r.status)) await stopRun(runs, r.id);
			}
			mkdirSync(runs.dir, { recursive: true });
			const state = runs.create(launch, undefined, session());
			launchSupervisor(runs, state.id);
			// The run is going: a pick it cannot keep is no reason to say it failed.
			try {
				memory.set(folder, inputs.picks);
			} catch {
				// next time it decides or asks again
			}
			runs.prune(folder);
			runs.pruneOld();
			const picked = pickedLabels(config, folder, memory);
			return ok({ run: state, ...(picked ? { picked } : {}) });
		}
		case 'again': {
			const id = args.ids[0] ?? '';
			const launch = runs.launch(id);
			if (!launch) throw new RunConfigError(`no run ${id}`);
			for (const r of runs.list(launch.folder)) {
				if ((r.id === id || r.configId === launch.configId) && isLive(r.status)) await stopRun(runs, r.id);
			}
			const state = runs.create(launch, undefined, session() ?? runs.read(id)?.session);
			launchSupervisor(runs, state.id);
			// The old run's place in the list is the new one's; its folder goes
			// unless its supervisor still writes there (prune takes it later).
			if (!alive(runs.read(id)?.supervisor)) runs.remove(id);
			return ok({ run: state });
		}
		case 'stop': {
			let ids = args.ids;
			if (args.all) {
				if (!args.folder) throw new RunConfigError('stop --all needs --folder');
				ids = runs.list(args.folder).filter((r) => isLive(r.status)).map((r) => r.id);
			}
			const stopped = await Promise.all(ids.map((id) => stopRun(runs, id)));
			return ok({ runs: stopped.filter(Boolean) });
		}
		case 'ps': {
			const list = runs.list(args.folder);
			if (!args.adopt) return ok({ runs: list });
			// ttt is back: the runs it kept are its own again, this session's.
			const now = session();
			for (const r of list) {
				if (r.kept) runs.mark(r.id, 'keep', false);
				if (now && isLive(r.status)) runs.own(r.id, now);
			}
			return ok({ runs: list.map((r) => ({ ...r, kept: false, ...(now && isLive(r.status) ? { session: now } : {}) })) });
		}
		case 'remove': {
			const removed = args.ids.filter((id) => {
				const s = runs.read(id);
				if (!s || isLive(s.status)) return false;
				runs.remove(id);
				return true;
			});
			return ok({ removed });
		}
		case 'keep': {
			for (const id of args.ids) if (runs.read(id)) runs.mark(id, 'keep');
			return ok({ kept: args.ids });
		}
		case 'save': {
			const { folder, file } = contextOf(args);
			const config = listConfigs(folder, { file }).configs.find((c) => c.id === args.config);
			if (!config) throw new RunConfigError(`no configuration "${args.config}" in ${folder}`);
			const path = join(folder, RUN_JSON);
			const text = readSmall(path);
			const data = (text === undefined ? { configurations: [] } : parseJsonc(text, RUN_JSON)) as { configurations: Record<string, unknown>[] };
			if (!Array.isArray(data.configurations)) data.configurations = [];
			let name = config.name;
			for (let n = 2; data.configurations.some((c) => c.name === name); n++) name = `${config.name} (${n})`;
			data.configurations.push(toRunJson({ ...config, name }));
			mkdirSync(dirname(path), { recursive: true });
			writeAtomic(path, `${JSON.stringify(data, null, '\t')}\n`);
			return ok({ saved: name, file: path });
		}
		case 'supervise':
			return { out: {}, code: await supervise(runs, args.ids[0] ?? '') };
		default:
			throw new RunConfigError(`symbiosis run: unknown command "${args.command}" (list, start, again, stop, ps, keep, remove, save)`);
	}
}

/** The launcher's session, which ttt and the `symbiosis run` it starts inherit. */
function session(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.SYMBIOSIS_SESSION || undefined;
}

function within(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * The runs still going that nobody chose to keep: those of the session; with
 * no session, those of `folder`, a folder in it, or a folder around it (the
 * git root).
 */
export function orphans(runs: Runs, folder: string, session?: string): RunState[] {
	return runs.list().filter((r) => {
		if (!isLive(r.status) || r.kept) return false;
		return session ? r.session === session : within(folder, r.folder) || within(r.folder, folder);
	});
}

/**
 * After ttt quits: when programs it started still run and nobody chose to
 * keep them (ttt quit from its terminal, or crashed), asks whether to stop
 * them. With no terminal to ask, they keep running; the Run panel shows them
 * the next time.
 */
export async function askStopRuns(folder: string, sessionId?: string, runs = new Runs(runsDir())): Promise<void> {
	const left = orphans(runs, folder, sessionId);
	if (left.length === 0 || !process.stdin.isTTY) return;
	const names = left.map((r) => r.name).join(', ');
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	let answer = '';
	try {
		answer = await rl.question(`symbiosis: ${left.length === 1 ? 'a program still runs' : `${left.length} programs still run`} (${names}). Stop ${left.length === 1 ? 'it' : 'them'}? [Y/n] `);
	} finally {
		rl.close();
	}
	if (/^n/i.test(answer.trim())) {
		for (const r of left) runs.mark(r.id, 'keep');
		process.stderr.write('symbiosis: they keep running; `symbiosis run ps` lists them, the Run panel shows them in ttt.\n');
		return;
	}
	await Promise.all(left.map((r) => stopRun(runs, r.id)));
}

/** `symbiosis run ...`: prints the result; returns the exit code. */
export async function runMain(argv: readonly string[]): Promise<number> {
	try {
		const args = parseRunArgs(argv);
		const { out, code } = await runCommand(args);
		if (args.command !== 'supervise') process.stdout.write(`${JSON.stringify(out)}\n`);
		return code;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stdout.write(`${JSON.stringify({ ok: false, error: message })}\n`);
		return error instanceof RunConfigError ? 2 : 1;
	}
}
