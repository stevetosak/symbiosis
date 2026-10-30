// One debug session: drives the adapter through DAP and keeps the DebugView
// (core/debug/view.ts) that the plugin shows. It knows nothing of files or
// processes: the supervisor (launcher/debug.ts) gives it the connection,
// writes what it shows, and passes the plugin's commands in.
//
// The flow, as DAP has it: initialize; launch (its answer may come only after
// configurationDone); at `initialized` the breakpoints, the exception
// filters the adapter turns on by default, configurationDone. Then events:
// `stopped` fetches the threads, the stack, the chosen frame's scopes and
// the variables under every expanded key; `continued` and each step clear
// them. An adapter may start child sessions (`startDebugging`: js-debug does
// for each process it launches); each is a target of its own on a new
// connection, and a stop is the target's that stopped.
//
// Watches are expressions evaluated again at each stop, in the chosen frame.
import { realpathSync } from 'node:fs';
import type { AdapterStart } from './adapters.ts';
import { type DapClient, type DebugProtocol as P } from './dap.ts';
import type { BreakpointSpec, BreakpointView, DebugCommand, DebugStatus, DebugView, FrameView, ScopeView, StopView, VarView, EvalView } from './view.ts';

export const MAX_FRAMES = 50;
export const MAX_VARS = 200;
/** Variables requests at one stop, for the expanded keys. */
export const MAX_FETCHES = 40;
export const MAX_WATCHES = 10;
/** A value longer than this is cut: the panel shows a line of it. */
export const VALUE_MAX = 1000;
export const SEP = '\t';
/** After `exited`, how long the session waits for `terminated`. */
export const EXITED_MS = 1500;
/** node's inspector says these on stderr; they are not the program's. */
const NOISE = /^(Debugger attached\.|Waiting for the debugger to disconnect\.\.\.|Debugger listening on ws:\S+|For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector)\s*$/;

export interface SessionHost {
	/** The adapter's connection; called again for a child session (a TCP adapter makes a new one, stdio cannot). */
	connect(): Promise<DapClient>;
	onView(view: DebugView): void;
	onOutput(category: string, text: string): void;
	/** The debuggee's pid, from the `process` event. */
	onProcess?(pid: number): void;
	/** runInTerminal: start the program and give its pid (its output goes to the run). */
	spawnTerminal?(args: P.RunInTerminalRequestArguments): number | undefined;
	/** Whether connect() can be called again. */
	readonly reconnects: boolean;
}

interface Target {
	readonly client: DapClient;
	readonly name: string;
	caps: P.Capabilities;
	ended: boolean;
	configured: boolean;
	lastThread?: number;
}

interface Stop extends StopView {
	readonly target: Target;
}

function real(path: string | undefined): string | undefined {
	if (!path || !path.startsWith('/')) return undefined;
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function cut(text: string): string {
	return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX)}…` : text;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class DebugSession {
	private readonly adapter: AdapterStart;
	private readonly host: SessionHost;
	private readonly targets: Target[] = [];
	private root: Target | undefined;
	private readonly bps: Map<string, BreakpointSpec[]>;
	/** path → target → what that target said of the file's breakpoints. */
	private readonly bpAnswers = new Map<string, Map<string, BreakpointView[]>>();
	private readonly bpView = new Map<string, BreakpointView[]>();
	/** A breakpoint's id (as its adapter gave it) → its file and place, for `breakpoint` events. */
	private readonly bpIds = new Map<string, { path: string; index: number }>();

	private status: DebugStatus = 'starting';
	private stop?: Stop;
	private threads: { id: number; name: string }[] = [];
	private frames: FrameView[] = [];
	private frameIndex = 0;
	private scopes: ScopeView[] = [];
	private readonly vars = new Map<string, VarView[]>();
	private readonly refs = new Map<string, number>();
	private readonly expanded = new Set<string>();
	/** Scopes you closed: the first scope of a frame is open unless its name is here. */
	private readonly collapsed = new Set<string>();
	private watches: string[] = [];
	private evals: EvalView[] = [];
	private seq = 0;
	private ack = 0;
	private error: string | undefined;
	/** Goes up at each stop and each go: what a fetch of an older one finds is dropped. */
	private epoch = 0;
	private exitCode: number | undefined;
	private finish!: (code: number | undefined) => void;
	/** The program's exit code when the adapter said it. */
	readonly ended: Promise<number | undefined>;
	/** How it ended: `terminated` (the adapter said so), `exited` (the program did; no word after), `closed` (the connection went). */
	endedBy: 'terminated' | 'exited' | 'closed' | undefined;

	constructor(adapter: AdapterStart, breakpoints: Map<string, BreakpointSpec[]>, host: SessionHost) {
		this.adapter = adapter;
		this.host = host;
		this.bps = new Map(breakpoints);
		this.ended = new Promise((resolve) => {
			this.finish = resolve;
		});
	}

	view(): DebugView {
		return {
			seq: this.seq,
			ack: this.ack,
			status: this.status,
			type: String(this.adapter.launch.type ?? this.adapter.adapterID),
			adapter: this.adapter.label,
			...(this.stop ? { stop: { reason: this.stop.reason, threadId: this.stop.threadId, ...(this.stop.description ? { description: this.stop.description } : {}), ...(this.stop.text ? { text: this.stop.text } : {}) } } : {}),
			threads: this.threads,
			frames: this.frames,
			frame: this.frameIndex,
			scopes: this.scopes,
			vars: Object.fromEntries(this.vars),
			expanded: [...this.expanded],
			breakpoints: Object.fromEntries(this.bpView),
			evals: this.evals,
			...(this.error ? { error: this.error } : {}),
		};
	}

	private emit(): void {
		this.seq++;
		this.host.onView(this.view());
	}

	// Start ------------------------------------------------------------------------

	/** Starts the session; throws when the adapter cannot launch the program. */
	async start(): Promise<void> {
		const client = await this.host.connect();
		client.onClose(() => this.end('closed'));
		this.root = await this.attach(client, 'root', 'launch', this.adapter.launch);
		if (this.status === 'starting') this.status = 'running';
		this.emit();
	}

	private async attach(client: DapClient, name: string, request: string, args: Readonly<Record<string, unknown>>): Promise<Target> {
		const t: Target = { client, name, caps: {}, ended: false, configured: false };
		this.targets.push(t);
		this.listen(t);
		t.caps = (await client.request<P.Capabilities>('initialize', {
			clientID: 'symbiosis', clientName: 'symbiosis (ttt)', adapterID: this.adapter.adapterID, locale: 'en',
			linesStartAt1: true, columnsStartAt1: true, pathFormat: 'path',
			supportsVariableType: true, supportsVariablePaging: false,
			supportsRunInTerminalRequest: this.host.spawnTerminal !== undefined,
			supportsStartDebuggingRequest: this.host.reconnects,
			supportsProgressReporting: false, supportsInvalidatedEvent: false, supportsMemoryReferences: false,
		}, 20_000)) ?? {};
		const initialized = client.once('initialized', 30_000);
		const launched = client.request(request, args);
		// Each is awaited below or not at all (a failed launch never initializes).
		initialized.catch(() => {});
		launched.catch(() => {});
		try {
			// An adapter that cannot launch says so before `initialized`, or never sends it.
			await Promise.race([initialized, launched.then(() => initialized)]);
		} catch (error) {
			throw new Error(`${request} failed: ${message(error)}`);
		}
		await this.configure(t);
		try {
			await launched;
		} catch (error) {
			throw new Error(`${request} failed: ${message(error)}`);
		}
		t.configured = true;
		return t;
	}

	private async configure(t: Target): Promise<void> {
		for (const path of this.bps.keys()) await this.sendBreakpoints(t, path);
		const filters = t.caps.exceptionBreakpointFilters;
		if (filters && filters.length > 0) {
			await t.client.request('setExceptionBreakpoints', { filters: filters.filter((f) => f.default).map((f) => f.filter) }).catch(() => {});
		}
		if (t.caps.supportsConfigurationDoneRequest) await t.client.request('configurationDone');
	}

	private listen(t: Target): void {
		const c = t.client;
		c.on('stopped', (body: P.StoppedEvent['body']) => void this.stopped(t, body));
		c.on('continued', (body: P.ContinuedEvent['body']) => {
			if (this.stop?.target !== t) return;
			if (body.allThreadsContinued === false && body.threadId !== this.stop.threadId) return;
			this.going();
			this.emit();
		});
		c.on('output', (body: P.OutputEvent['body']) => {
			if (body.category === 'telemetry' || typeof body.output !== 'string') return;
			const text = body.output.split(/(?<=\n)/).filter((line) => !NOISE.test(line.replace(/\r?\n$/, ''))).join('');
			if (text) this.host.onOutput(body.category ?? 'console', text);
		});
		c.on('exited', (body: P.ExitedEvent['body']) => {
			if (typeof body.exitCode === 'number') this.exitCode = body.exitCode;
			// `terminated` should follow; an adapter that waits for a disconnect first is done too.
			if (t === this.root) setTimeout(() => this.end('exited'), EXITED_MS).unref();
		});
		c.on('terminated', () => {
			t.ended = true;
			if (t === this.root) return this.end('terminated');
			if (this.stop?.target === t) {
				this.going();
				this.emit();
			}
		});
		c.on('process', (body: P.ProcessEvent['body']) => {
			if (typeof body.systemProcessId === 'number') this.host.onProcess?.(body.systemProcessId);
		});
		c.on('thread', (body: P.ThreadEvent['body']) => {
			if (body.reason === 'started') t.lastThread = body.threadId;
		});
		c.on('breakpoint', (body: P.BreakpointEvent['body']) => {
			const b = body.breakpoint;
			const at = b.id !== undefined ? this.bpIds.get(`${t.name}:${b.id}`) : undefined;
			if (!at) return;
			const list = [...(this.bpAnswers.get(at.path)?.get(t.name) ?? [])];
			const old = list[at.index];
			if (!old) return;
			list[at.index] = { line: b.line ?? old.line, verified: b.verified, ...(b.message ? { message: b.message } : {}) };
			this.answer(at.path, t, list);
			this.emit();
		});
		c.handle('runInTerminal', (args: P.RunInTerminalRequestArguments) => {
			const pid = this.host.spawnTerminal?.(args);
			if (pid === undefined) throw new Error('could not start the program');
			return { processId: pid };
		});
		c.handle('startDebugging', (args: P.StartDebuggingRequestArguments) => {
			if (!this.host.reconnects) throw new Error('this adapter talks over stdio: no second session');
			// Answered at once; the child comes up on its own connection.
			void this.child(args);
			return {};
		});
	}

	private async child(args: P.StartDebuggingRequestArguments): Promise<void> {
		try {
			const client = await this.host.connect();
			await this.attach(client, `child${this.targets.length}`, args.request, args.configuration);
		} catch (error) {
			this.host.onOutput('console', `symbiosis: a child session did not start: ${message(error)}\n`);
		}
	}

	private end(by: 'terminated' | 'exited' | 'closed'): void {
		if (this.status === 'ended') return;
		this.endedBy = by;
		this.status = 'ended';
		this.stop = undefined;
		this.frames = [];
		this.scopes = [];
		this.vars.clear();
		this.refs.clear();
		this.epoch++;
		this.emit();
		this.finish(this.exitCode);
	}

	// Stops --------------------------------------------------------------------------

	/** Running again: what the stop showed is gone (its references are no good now). */
	private going(): void {
		this.epoch++;
		this.status = this.status === 'ended' ? 'ended' : 'running';
		this.stop = undefined;
		this.frames = [];
		this.frameIndex = 0;
		this.scopes = [];
		this.vars.clear();
		this.refs.clear();
		this.evals = this.evals.map((e) => ({ ...e, ref: 0 }));
	}

	private async threadOf(t: Target, given: number | undefined): Promise<number | undefined> {
		if (given !== undefined) return given;
		try {
			const r = await t.client.request<P.ThreadsResponse['body']>('threads');
			return r.threads[0]?.id ?? t.lastThread;
		} catch {
			return t.lastThread;
		}
	}

	private async stopped(t: Target, body: P.StoppedEvent['body']): Promise<void> {
		const epoch = ++this.epoch;
		const threadId = await this.threadOf(t, body.threadId);
		if (epoch !== this.epoch || threadId === undefined) return;
		t.lastThread = threadId;
		this.status = 'paused';
		this.stop = {
			target: t, reason: body.reason, threadId,
			...(body.description ? { description: body.description } : {}),
			...(body.text ? { text: body.text } : {}),
		};
		await this.loadStack(epoch);
	}

	private async loadStack(epoch: number): Promise<void> {
		const stop = this.stop;
		if (!stop) return;
		const c = stop.target.client;
		try {
			const threads = await c.request<P.ThreadsResponse['body']>('threads');
			if (epoch !== this.epoch) return;
			this.threads = threads.threads.map((th) => ({ id: th.id, name: th.name }));
		} catch {
			// some adapters answer threads only while running; the stop is what counts
		}
		let trace: P.StackTraceResponse['body'];
		try {
			trace = await c.request('stackTrace', { threadId: stop.threadId, startFrame: 0, levels: MAX_FRAMES });
		} catch (error) {
			if (epoch !== this.epoch) return;
			this.error = `stackTrace: ${message(error)}`;
			this.emit();
			return;
		}
		if (epoch !== this.epoch) return;
		this.frames = trace.stackFrames.map((f) => {
			const path = real(f.source?.path);
			return { id: f.id, name: f.name, line: f.line, column: f.column, ...(path ? { path } : {}), ...(f.presentationHint && f.presentationHint !== 'normal' ? { hint: f.presentationHint } : {}) };
		});
		// The first frame with a file of its own that is not a library's.
		const own = this.frames.findIndex((f) => f.path && f.hint !== 'subtle' && f.hint !== 'label');
		this.frameIndex = own >= 0 ? own : 0;
		if (stop.reason === 'exception' && stop.target.caps.supportsExceptionInfoRequest) {
			try {
				const info = await c.request<P.ExceptionInfoResponse['body']>('exceptionInfo', { threadId: stop.threadId });
				if (epoch !== this.epoch) return;
				const text = [info.exceptionId, info.description].filter(Boolean).join(': ');
				if (text) this.stop = { ...stop, text };
			} catch {
				// the stop's own text stays
			}
		}
		await this.loadFrame(epoch);
	}

	private async loadFrame(epoch: number): Promise<void> {
		const stop = this.stop;
		const frame = this.frames[this.frameIndex];
		this.scopes = [];
		this.vars.clear();
		this.refs.clear();
		if (!stop || !frame) {
			this.emit();
			return;
		}
		try {
			const r = await stop.target.client.request<P.ScopesResponse['body']>('scopes', { frameId: frame.id });
			if (epoch !== this.epoch) return;
			this.scopes = r.scopes.map((s) => ({ name: s.name, ref: s.variablesReference, expensive: s.expensive, key: s.name }));
		} catch (error) {
			if (epoch !== this.epoch) return;
			this.error = `scopes: ${message(error)}`;
		}
		for (const s of this.scopes) this.refs.set(s.key, s.ref);
		// A frame's first scope (its locals) is open unless you closed one of that
		// name (js-debug names them after the function: "Local: add"); the others
		// as you left them.
		const first = this.scopes.find((s) => !s.expensive);
		if (first && !this.collapsed.has(first.key)) this.expanded.add(first.key);
		await this.evaluateWatches(epoch);
		if (epoch !== this.epoch) return;
		await this.fetchExpanded(epoch, [...this.scopes.map((s) => s.key), ...this.evals.map((e) => e.key)]);
		if (epoch !== this.epoch) return;
		this.emit();
	}

	/** Fetches the children of each expanded key under `roots`, and theirs, breadth first. */
	private async fetchExpanded(epoch: number, roots: readonly string[]): Promise<void> {
		const stop = this.stop;
		if (!stop) return;
		const queue = roots.filter((k) => this.expanded.has(k));
		let fetches = 0;
		while (queue.length > 0 && fetches < MAX_FETCHES) {
			const key = queue.shift()!;
			const ref = this.refs.get(key) ?? 0;
			if (ref <= 0) continue;
			fetches++;
			let children: VarView[];
			try {
				const r = await stop.target.client.request<P.VariablesResponse['body']>('variables', { variablesReference: ref });
				if (epoch !== this.epoch) return;
				const seen = new Set<string>();
				children = r.variables.slice(0, MAX_VARS).map((v) => {
					let name = v.name;
					for (let n = 2; seen.has(name); n++) name = `${v.name} (${n})`;
					seen.add(name);
					return { name, value: cut(v.value), ref: v.variablesReference, key: `${key}${SEP}${name}`, ...(v.type ? { type: v.type } : {}) };
				});
				if (r.variables.length > MAX_VARS) children.push({ name: '…', value: `${r.variables.length - MAX_VARS} more`, ref: 0, key: `${key}${SEP}…` });
			} catch (error) {
				if (epoch !== this.epoch) return;
				children = [{ name: '!', value: message(error), ref: 0, key: `${key}${SEP}!` }];
			}
			this.vars.set(key, children);
			for (const child of children) {
				this.refs.set(child.key, child.ref);
				if (child.ref > 0 && this.expanded.has(child.key)) queue.push(child.key);
			}
		}
	}

	private async evaluate(expr: string, epoch: number, index: number): Promise<EvalView> {
		const key = `watch${SEP}${index}`;
		const stop = this.stop;
		const target = stop?.target ?? this.root;
		const frame = stop ? this.frames[this.frameIndex] : undefined;
		if (!target) return { expr, value: 'no session', ref: 0, key, error: true };
		try {
			const r = await target.client.request<P.EvaluateResponse['body']>('evaluate', { expression: expr, ...(frame ? { frameId: frame.id } : {}), context: 'watch' });
			if (epoch === this.epoch) this.refs.set(key, r.variablesReference);
			return { expr, value: cut(r.result), ref: r.variablesReference, key, ...(r.type ? { type: r.type } : {}) };
		} catch (error) {
			return { expr, value: message(error), ref: 0, key, error: true };
		}
	}

	private async evaluateWatches(epoch: number): Promise<void> {
		const out: EvalView[] = [];
		for (const [i, expr] of this.watches.entries()) {
			out.push(await this.evaluate(expr, epoch, i));
			if (epoch !== this.epoch) return;
		}
		this.evals = out;
	}

	// Commands -------------------------------------------------------------------

	/** Does one of the plugin's commands; its failure is the view's `error`. */
	async command(cmd: DebugCommand): Promise<void> {
		this.error = undefined;
		try {
			await this.run(cmd);
		} catch (error) {
			this.error = `${cmd.op}: ${message(error)}`;
		}
		this.ack = Math.max(this.ack, cmd.seq);
		this.emit();
	}

	private async run(cmd: DebugCommand): Promise<void> {
		switch (cmd.op) {
			case 'continue':
			case 'next':
			case 'stepIn':
			case 'stepOut': {
				const stop = this.stop;
				if (!stop) throw new Error('the program is not paused');
				// Running before the request goes: its stop may come in the same
				// read as its answer, and must not be undone by it.
				this.going();
				this.emit();
				try {
					await stop.target.client.request(cmd.op, { threadId: stop.threadId, ...(cmd.op === 'continue' ? {} : { granularity: 'line' }) });
				} catch (error) {
					// Still where it was.
					this.stop = stop;
					this.status = 'paused';
					await this.loadStack(++this.epoch);
					throw error;
				}
				return;
			}
			case 'pause': {
				if (this.stop) return;
				const t = [...this.targets].reverse().find((x) => !x.ended && x.configured) ?? this.root;
				if (!t) throw new Error('no session');
				const threadId = await this.threadOf(t, undefined);
				if (threadId === undefined) throw new Error('no thread to pause');
				await t.client.request('pause', { threadId });
				return;
			}
			case 'frame': {
				if (!this.stop || cmd.index < 0 || cmd.index >= this.frames.length) return;
				this.frameIndex = cmd.index;
				await this.loadFrame(++this.epoch);
				return;
			}
			case 'expand': {
				this.expanded.add(cmd.key);
				this.collapsed.delete(cmd.key);
				if (this.stop) await this.fetchExpanded(this.epoch, [cmd.key]);
				return;
			}
			case 'collapse': {
				if (this.scopes.some((s) => s.key === cmd.key)) this.collapsed.add(cmd.key);
				for (const k of [...this.expanded]) if (k === cmd.key || k.startsWith(cmd.key + SEP)) this.expanded.delete(k);
				return;
			}
			case 'breakpoints': {
				// (Lua's JSON writes an empty list as {}.)
				const lines = (Array.isArray(cmd.lines) ? cmd.lines : []).filter((b) => Number.isInteger(b?.line) && b.line > 0);
				if (lines.length > 0) this.bps.set(cmd.path, [...lines]);
				else this.bps.delete(cmd.path);
					for (const t of this.targets) if (!t.ended && t.configured) await this.sendBreakpoints(t, cmd.path);
				if (lines.length === 0) {
					this.bpView.delete(cmd.path);
					this.bpAnswers.delete(cmd.path);
				}
				return;
			}
			case 'evaluate': {
				const expr = cmd.expr.trim();
				if (!expr) return;
				this.watches = [expr, ...this.watches.filter((w) => w !== expr)].slice(0, MAX_WATCHES);
				const epoch = this.epoch;
				await this.evaluateWatches(epoch);
				if (this.stop && epoch === this.epoch) await this.fetchExpanded(epoch, this.evals.map((e) => e.key));
				return;
			}
			case 'unwatch': {
				this.watches = this.watches.filter((w) => w !== cmd.expr);
				this.evals = this.evals.filter((e) => e.expr !== cmd.expr);
				return;
			}
		}
	}

	private async sendBreakpoints(t: Target, path: string): Promise<void> {
		const lines = this.bps.get(path) ?? [];
		try {
			const r = await t.client.request<P.SetBreakpointsResponse['body']>('setBreakpoints', {
				source: { path },
				breakpoints: lines.map((b) => ({ line: b.line, ...(b.condition ? { condition: b.condition } : {}) })),
				lines: lines.map((b) => b.line),
			});
			const views = lines.map((b, i): BreakpointView => {
				const got = r.breakpoints[i];
				if (got?.id !== undefined) this.bpIds.set(`${t.name}:${got.id}`, { path, index: i });
				return { line: got?.line ?? b.line, verified: got?.verified ?? false, ...(got?.message ? { message: got.message } : {}) };
			});
			this.answer(path, t, views);
		} catch (error) {
			this.answer(path, t, lines.map((b) => ({ line: b.line, verified: false, message: message(error) })));
		}
	}

	/**
	 * What a target said of a file's breakpoints. A breakpoint counts as verified
	 * when one target verified it (js-debug's root session never does: its
	 * child, the process, does), at the line that target put it.
	 */
	private answer(path: string, t: Target, views: BreakpointView[]): void {
		const byTarget = this.bpAnswers.get(path) ?? new Map<string, BreakpointView[]>();
		byTarget.set(t.name, views);
		this.bpAnswers.set(path, byTarget);
		const lines = this.bps.get(path) ?? [];
		this.bpView.set(path, lines.map((b, i) => {
			const all = [...byTarget.values()].map((v) => v[i]).filter((v): v is BreakpointView => v !== undefined);
			return all.find((v) => v.verified) ?? all[0] ?? { line: b.line, verified: false };
		}));
	}

	/** Ends the session with a disconnect (also after the program ended: the adapter waits for it); the program goes with it. */
	async terminate(timeoutMs = 3000): Promise<void> {
		const root = this.root;
		if (root && !root.client.isClosed) {
			try {
				await root.client.request('disconnect', { terminateDebuggee: true, restart: false }, timeoutMs);
			} catch {
				// the adapter is gone or does not answer: the supervisor kills it
			}
		}
		this.end('terminated');
	}
}
