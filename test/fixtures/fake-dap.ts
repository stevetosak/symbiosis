// A debug adapter for the tests: speaks DAP, "runs" a program file one line
// at a time, with no real debugger. Run as a program it talks on stdin and
// stdout (the supervisor's tests start it as a run's adapter); in the same
// process, FakeAdapter talks on any pair of streams (the session's tests).
//
// The program: each line is a statement. `print TEXT` prints TEXT (in two
// output events, as an adapter cuts a write); `fail` exits 1; the end exits
// with the launch's exitCode (0). Stops: breakpoints (before the line runs),
// a step (next, stepIn, stepOut: one line), stopOnEntry. Variables: Locals
// { line, list (two children) }, Globals { G }. evaluate: `line * 10`, and
// `filters` gives the exception filters it was set. `child: true` in the
// launch: before running it asks for a child session (startDebugging), which
// runs the program instead (js-debug's way).
import { readFileSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Framer, frame } from '../../core/debug/dap.ts';

type Msg = { seq: number; type: string; command?: string; arguments?: any; request_seq?: number; success?: boolean; body?: any };

export class FakeAdapter {
	private seq = 1;
	private lines: string[] = [];
	private program = '';
	private at = 1;
	private bps = new Set<number>();
	private filters: string[] = [];
	private launchSeq = -1;
	private launchArgs: any = {};
	private configured = false;
	private exitCode = 0;
	private ended = false;
	private readonly out: Writable;
	/** The requests it got, by command: for the tests to look at. */
	readonly got: Msg[] = [];
	onEnd: (() => void) | undefined;
	/** The program ended (a child's end ends its root: the test wires it). */
	onFinish: (() => void) | undefined;

	constructor(input: Readable, out: Writable) {
		this.out = out;
		const framer = new Framer((text) => this.receive(JSON.parse(text)));
		input.on('data', (chunk: Buffer) => framer.push(chunk));
	}

	private send(m: object): void {
		if (this.ended && (m as Msg).type !== 'response') return;
		this.out.write(frame({ seq: this.seq++, ...m }));
	}

	private respond(req: Msg, body?: unknown, error?: string): void {
		this.send({ type: 'response', request_seq: req.seq, command: req.command, success: !error, ...(error ? { message: error } : {}), ...(body === undefined ? {} : { body }) });
	}

	private event(event: string, body?: unknown): void {
		this.send({ type: 'event', event, ...(body === undefined ? {} : { body }) });
	}

	private stop(reason: string): void {
		this.event('stopped', { reason, threadId: 1, allThreadsStopped: true });
	}

	private finish(code: number): void {
		this.event('exited', { exitCode: code });
		this.event('terminated');
		this.onFinish?.();
	}

	/** `terminated`, as a root says when its child ended. */
	terminate(): void {
		this.event('terminated');
	}

	/** Runs line `this.at`; false when the program ended. */
	private exec(): boolean {
		const line = this.lines[this.at - 1];
		if (line === undefined) {
			this.finish(this.exitCode);
			return false;
		}
		if (line.startsWith('print ')) {
			const text = `${line.slice(6)}\n`;
			const cut = Math.max(1, Math.floor(text.length / 2));
			this.event('output', { category: 'stdout', output: text.slice(0, cut) });
			this.event('output', { category: 'stdout', output: text.slice(cut) });
		}
		if (line.trim() === 'fail') {
			this.finish(1);
			return false;
		}
		this.at++;
		if (this.at > this.lines.length) {
			this.finish(this.exitCode);
			return false;
		}
		return true;
	}

	private run(): void {
		for (;;) {
			if (!this.exec()) return;
			if (this.bps.has(this.at)) return this.stop('breakpoint');
		}
	}

	private start(): void {
		this.event('process', { name: this.program, systemProcessId: process.pid, isLocalProcess: true, startMethod: 'launch' });
		this.event('thread', { reason: 'started', threadId: 1 });
		if (this.launchArgs.stopOnEntry) return this.stop('entry');
		if (this.bps.has(this.at)) return this.stop('breakpoint');
		this.run();
	}

	private receive(m: Msg): void {
		if (m.type === 'response') return;
		this.got.push(m);
		const a = m.arguments ?? {};
		switch (m.command) {
			case 'initialize':
				this.respond(m, {
					supportsConfigurationDoneRequest: true,
					exceptionBreakpointFilters: [{ filter: 'uncaught', label: 'Uncaught', default: true }, { filter: 'raised', label: 'Raised', default: false }],
				});
				return;
			case 'launch': {
				this.launchArgs = a;
				this.program = a.program ?? '';
				this.exitCode = typeof a.exitCode === 'number' ? a.exitCode : 0;
				try {
					this.lines = readFileSync(this.program, 'utf8').replace(/\n$/, '').split('\n');
				} catch {
					this.respond(m, undefined, `no such program: ${this.program}`);
					return;
				}
				if (a.child) {
					// js-debug: the root asks for a child, which runs the program.
					this.respond(m);
					this.event('initialized');
					this.send({ type: 'request', command: 'startDebugging', arguments: { request: 'launch', configuration: { ...a, child: false, program: this.program } } });
					return;
				}
				this.launchSeq = m.seq;
				this.event('initialized');
				return;
			}
			case 'setBreakpoints': {
				const lines: number[] = (a.breakpoints ?? []).map((b: { line: number }) => b.line);
				this.bps = new Set(lines);
				this.respond(m, { breakpoints: lines.map((line, i) => ({ id: i + 1, line, verified: line <= Math.max(this.lines.length, 1000) })) });
				return;
			}
			case 'setExceptionBreakpoints':
				this.filters = a.filters ?? [];
				this.respond(m);
				return;
			case 'configurationDone':
				this.respond(m);
				this.configured = true;
				// The launch's answer comes after configurationDone (debugpy's way).
				if (this.launchSeq >= 0) {
					this.respond({ seq: this.launchSeq, type: 'request', command: 'launch' });
					this.start();
				}
				return;
			case 'threads':
				this.respond(m, { threads: [{ id: 1, name: 'main' }] });
				return;
			case 'stackTrace':
				this.respond(m, {
					stackFrames: [
						{ id: 1000 + this.at, name: 'main', line: this.at, column: 1, source: { path: this.program } },
						{ id: 1, name: 'lib', line: 7, column: 1, source: { path: '/nowhere/lib.py' }, presentationHint: 'subtle' },
					],
					totalFrames: 2,
				});
				return;
			case 'scopes':
				this.respond(m, { scopes: [{ name: 'Locals', variablesReference: 10, expensive: false }, { name: 'Globals', variablesReference: 20, expensive: false }] });
				return;
			case 'variables': {
				const ref = a.variablesReference;
				const vars = ref === 10
					? [{ name: 'line', value: String(this.at), type: 'int', variablesReference: 0 }, { name: 'list', value: '[1, 2]', type: 'list', variablesReference: 11 }]
					: ref === 11
						? [{ name: '0', value: '1', variablesReference: 0 }, { name: '1', value: '2', variablesReference: 0 }]
						: ref === 20 ? [{ name: 'G', value: '"global"', variablesReference: 0 }] : [];
				this.respond(m, { variables: vars });
				return;
			}
			case 'next':
			case 'stepIn':
			case 'stepOut':
				this.respond(m);
				if (this.exec()) this.stop('step');
				return;
			case 'continue':
				this.respond(m, { allThreadsContinued: true });
				this.run();
				return;
			case 'pause':
				this.respond(m);
				this.stop('pause');
				return;
			case 'evaluate': {
				const expr = String(a.expression ?? '');
				if (expr === 'line * 10') return this.respond(m, { result: String(this.at * 10), variablesReference: 0 });
				if (expr === 'filters') return this.respond(m, { result: this.filters.join(','), variablesReference: 0 });
				if (expr === 'list') return this.respond(m, { result: '[1, 2]', variablesReference: 11 });
				return this.respond(m, undefined, `cannot evaluate ${expr}`);
			}
			case 'disconnect':
				this.respond(m);
				if (!this.ended) this.event('terminated');
				this.ended = true;
				this.onEnd?.();
				return;
			default:
				this.respond(m, undefined, `fake-dap: no ${m.command}`);
		}
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const adapter = new FakeAdapter(process.stdin, process.stdout);
	adapter.onEnd = () => setTimeout(() => process.exit(0), 20);
	process.stdin.on('end', () => process.exit(0));
}
