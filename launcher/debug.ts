// The supervisor of a debug session (`symbiosis run supervise ID` for a run
// whose launch has `debug`): starts the debug adapter in a process group of
// its own, gives core/debug/session.ts its connection, and is the files
// between the session and the plugin (core/debug/view.ts):
//
//   debug.json     the view, at each change
//   debug-in.json  the plugin's commands, read every POLL_MS
//   state.json     as for every run; `paused` says where it stopped
//   tail.txt, output.log   the program's output (DAP output events)
//   dap.log        each DAP message, for when an adapter misbehaves (up to DAP_LOG_MAX)
//
// `stop` (the marker of `symbiosis run stop`) disconnects with
// terminateDebuggee; the adapter and the program that are left are killed.
import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { AdapterStart } from '../core/debug/adapters.ts';
import { DapClient, type DebugProtocol as P } from '../core/debug/dap.ts';
import { DebugSession } from '../core/debug/session.ts';
import { type DebugView, parseBreakpoints, parseCommands } from '../core/debug/view.ts';
import type { Launch } from '../core/run/list.ts';
import { alive, HEARTBEAT_MS, killGroup, readJson, type RunState, type Runs, writeAtomic } from '../core/run/runs.ts';
import { RunOutput } from './run.ts';

const POLL_MS = 50;
/** How long the adapter has to say its port (a TCP adapter). */
const PORT_MS = 15_000;
const DAP_LOG_MAX = 4 * 1024 * 1024;

/** The plugin's breakpoints: breakpoints.json next to the runs folder. */
export function breakpointsFile(runs: Runs): string {
	return join(dirname(runs.dir), 'breakpoints.json');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A line with no end yet waits this long for the rest. */
const PARTIAL_MS = 120;

/**
 * Output events as whole lines. An adapter sends each write of the program
 * as an event (`print("sum", s)` is three); the program's stdout and stderr
 * would cut into each other's lines. Each category keeps its unfinished line
 * until its end comes, or PARTIAL_MS pass (a prompt with no newline).
 */
export class LineJoiner {
	private readonly pending = new Map<string, string>();
	private timer: NodeJS.Timeout | undefined;
	private readonly out: (text: string) => void;

	constructor(out: (text: string) => void) {
		this.out = out;
	}

	push(category: string, text: string): void {
		const all = (this.pending.get(category) ?? '') + text;
		const cut = all.lastIndexOf('\n') + 1;
		if (cut > 0) this.out(all.slice(0, cut));
		const rest = all.slice(cut);
		if (rest) this.pending.set(category, rest);
		else this.pending.delete(category);
		if (this.timer) clearTimeout(this.timer);
		this.timer = this.pending.size > 0 ? setTimeout(() => this.flush(), PARTIAL_MS) : undefined;
	}

	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		for (const text of this.pending.values()) this.out(text);
		this.pending.clear();
	}
}

/** The port an adapter prints, by its transport's pattern, from its stdout and stderr. */
function portOf(child: ChildProcess, pattern: string, timeoutMs: number): Promise<number> {
	const re = new RegExp(pattern);
	return new Promise((resolve, reject) => {
		let seen = '';
		const timer = setTimeout(() => done(new Error(`the debug adapter did not say its port in ${timeoutMs / 1000} s${seen ? `: ${seen.trim().slice(-200)}` : ''}`)), timeoutMs);
		const look = (chunk: Buffer) => {
			seen += chunk.toString('utf8');
			const m = re.exec(seen);
			if (m) done(undefined, Number(m[1]));
		};
		const exit = (code: number | null) => done(new Error(`the debug adapter exited (${code}) before it listened${seen ? `: ${seen.trim().slice(-200)}` : ''}`));
		const done = (error?: Error, port?: number) => {
			clearTimeout(timer);
			child.stdout?.off('data', look);
			child.stderr?.off('data', look);
			child.off('exit', exit);
			if (error) reject(error);
			else resolve(port!);
		};
		child.stdout?.on('data', look);
		child.stderr?.on('data', look);
		child.on('exit', exit);
	});
}

function tcpClient(host: string, port: number, log: (dir: '>' | '<', text: string) => void): Promise<DapClient> {
	return new Promise((resolve, reject) => {
		const socket = connect(port, host);
		socket.once('connect', () => resolve(new DapClient(socket, socket, log)));
		socket.once('error', reject);
	});
}

/** The program and its arguments of runInTerminal, with its env (a null value takes the variable out). */
function terminalEnv(env: Record<string, string | null> | undefined): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = { ...process.env };
	for (const [k, v] of Object.entries(env ?? {})) {
		if (v === null) delete out[k];
		else out[k] = v;
	}
	return out;
}

async function end(child: ChildProcess | undefined, debuggee: number | undefined): Promise<void> {
	if (child?.pid && child.exitCode === null && child.signalCode === null) {
		killGroup(child.pid, 'SIGTERM');
		for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(50);
		killGroup(child.pid, 'SIGKILL');
	}
	if (debuggee && alive(debuggee)) {
		try {
			process.kill(debuggee, 'SIGTERM');
		} catch {
			// gone
		}
		for (let i = 0; i < 20 && alive(debuggee); i++) await sleep(50);
		if (alive(debuggee)) {
			try {
				process.kill(debuggee, 'SIGKILL');
			} catch {
				// gone
			}
		}
	}
}

/** Runs the debug session of run `id`; returns the exit code of the supervisor. */
export async function superviseDebug(runs: Runs, id: string, launch: Launch, first: RunState): Promise<number> {
	const debug = launch.debug!;
	const adapter: AdapterStart = debug.adapter;
	const { kept: _kept, session: _session, ...own } = first;
	let state: RunState = { ...own, status: 'starting', supervisor: process.pid, t: Date.now(), debug: debug.spec.type };
	const write = (patch: Partial<RunState>) => {
		state = { ...state, ...patch };
		runs.write(state);
	};
	write({});
	if (runs.marked(id, 'stop')) {
		write({ status: 'stopped', ended: Date.now() });
		return 0;
	}
	const output = new RunOutput(runs, id, () => write({ seq: state.seq + 1 }));
	const lines = new LineJoiner((text) => output.push(text));
	const say = (text: string) => {
		lines.flush();
		output.push(`${text}\n`);
	};
	const dapLog = openSync(runs.path(id, 'dap.log'), 'a');
	let dapLogged = 0;
	const log = (dir: '>' | '<', text: string) => {
		if (dapLogged > DAP_LOG_MAX) return;
		const line = `${new Date().toISOString().slice(11, 23)} ${dir} ${text}\n`;
		dapLogged += line.length;
		try {
			writeSync(dapLog, line);
		} catch {
			dapLogged = DAP_LOG_MAX + 1;
		}
	};
	const flusher = setInterval(() => output.flush(), 200);

	let child: ChildProcess | undefined;
	let debuggee: number | undefined;
	const children: ChildProcess[] = [];
	const finish = async (patch: Partial<RunState>) => {
		lines.flush();
		clearInterval(flusher);
		await end(child, debuggee);
		for (const c of children) if (c.pid) killGroup(c.pid, 'SIGKILL');
		output.close();
		closeSync(dapLog);
		write({ paused: undefined, ...patch, ended: Date.now() });
	};
	process.on('SIGHUP', () => {});
	process.on('uncaughtException', async (error) => {
		try {
			say(`symbiosis: ${error.message}`);
			await finish({ status: 'failed', error: `symbiosis debug: ${error.message}` });
		} finally {
			process.exit(1);
		}
	});

	say(`▶ debugging ${launch.name} with ${adapter.label}`);
	child = spawn(adapter.command, [...adapter.args], {
		cwd: adapter.cwd,
		env: { ...process.env, ...adapter.env },
		detached: true,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	const spawned = await new Promise<string | undefined>((resolve) => {
		child!.once('spawn', () => resolve(undefined));
		child!.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'ENOENT' ? `${adapter.command}: not found` : e.message));
	});
	if (spawned) {
		say(`symbiosis: the debug adapter did not start: ${spawned}`);
		await finish({ status: 'failed', error: spawned });
		return 0;
	}
	write({ pid: child.pid });
	child.stderr?.on('data', (chunk: Buffer) => log('<', `[adapter stderr] ${chunk.toString('utf8').trimEnd()}`));
	let adapterExit: string | undefined;
	child.on('exit', (code, signal) => {
		adapterExit = signal ? `the debug adapter ended on ${signal}` : `the debug adapter exited ${code}`;
	});

	let connections = 0;
	const port = adapter.transport.kind === 'tcp' ? portOf(child, adapter.transport.pattern, PORT_MS) : undefined;
	port?.catch(() => {});
	const session = new DebugSession(adapter, parseBreakpoints(readJson(breakpointsFile(runs))), {
		reconnects: adapter.transport.kind === 'tcp',
		async connect() {
			connections++;
			if (adapter.transport.kind === 'tcp') return tcpClient(adapter.transport.host, await port!, log);
			if (connections > 1) throw new Error('an adapter on stdio has one connection');
			return new DapClient(child!.stdin!, child!.stdout!, log);
		},
		onView(view: DebugView) {
			writeAtomic(runs.path(id, 'debug.json'), `${JSON.stringify(view)}\n`);
			const frame = view.status === 'paused' ? view.frames[view.frame] : undefined;
			const paused = view.status === 'paused' ? { reason: view.stop?.reason ?? 'pause', ...(frame?.path ? { path: frame.path, line: frame.line } : {}) } : undefined;
			if (JSON.stringify(paused) !== JSON.stringify(state.paused)) write({ paused });
		},
		onOutput(category, text) {
			lines.push(category, text);
		},
		onProcess(pid) {
			debuggee = pid;
			write({ debuggee: pid });
		},
		spawnTerminal(args: P.RunInTerminalRequestArguments) {
			const [command, ...rest] = args.args;
			if (!command) return undefined;
			const p = spawn(command, rest, { cwd: args.cwd || adapter.cwd, env: terminalEnv(args.env), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
			children.push(p);
			for (const stream of [p.stdout, p.stderr]) {
				const decoder = new StringDecoder('utf8');
				stream?.on('data', (chunk: Buffer) => output.push(chunk, decoder.write(chunk)));
			}
			p.on('error', (e) => say(`symbiosis: ${command}: ${e.message}`));
			return p.pid;
		},
	});

	try {
		await session.start();
	} catch (error) {
		const why = (error as Error).message;
		say(`symbiosis: ${why}`);
		if (adapterExit) say(`symbiosis: ${adapterExit}`);
		await finish({ status: runs.marked(id, 'stop') ? 'stopped' : 'failed', error: why });
		return 0;
	}
	write({ status: 'running', t: Date.now() });

	let over = false;
	let code: number | undefined;
	void session.ended.then((c) => {
		over = true;
		code = c;
	});
	let done = 0;
	let beat = Date.now();
	let stopped = false;
	while (!over) {
		if (runs.marked(id, 'stop')) {
			stopped = true;
			await session.terminate();
			break;
		}
		for (const cmd of parseCommands(readJson(runs.path(id, 'debug-in.json')))) {
			if (cmd.seq <= done) continue;
			await session.command(cmd);
			done = cmd.seq;
		}
		if (Date.now() - beat >= HEARTBEAT_MS) {
			beat = Date.now();
			write({ t: beat });
		}
		await sleep(POLL_MS);
	}
	// The adapter waits for a disconnect after the program ended.
	if (!stopped) await session.terminate(1000);
	const lost = !stopped && session.endedBy === 'closed' && code === undefined;
	if (lost) say(`symbiosis: ${adapterExit ?? 'the debug adapter closed the connection'}`);
	if (code !== undefined) say(`symbiosis: the program exited ${code}`);
	await finish(stopped
		? { status: 'stopped' }
		: lost
			? { status: 'failed', error: adapterExit ?? 'the debug adapter closed the connection' }
			: { status: 'exited', ...(code !== undefined ? { code } : {}) });
	return 0;
}
