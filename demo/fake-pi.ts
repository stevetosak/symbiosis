// A pi without a model, for the demo and the end-to-end tests. It loads the
// real extension (pi/index.ts) and plays the events pi sends it: a tool call,
// then the tool runs (the file changes on disk) and its result comes back.
// The tools are the ones the extension registers: pi's own edit and write,
// with symbiosis' `why` (pi/tools.ts), and propose.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import symbiosis from '../pi/index.ts';
import { pluginDir } from '../core/channel/file.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = {
	name: string;
	prepareArguments?: (args: unknown) => unknown;
	execute: (id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown, ctx?: unknown) => Promise<{ content?: { text?: string }[]; details?: unknown }>;
};
export type StepState = 'done' | 'now' | 'next';
export interface Edit {
	oldText: string;
	newText: string;
}

/** How a write or edit call went: blocked before it ran (the guard's reason), failed, or done. */
export interface CallResult {
	blocked?: string;
	error?: string;
}

export interface Proposal {
	kind: string;
	target: string;
	what: string;
	why: string;
}

/** The part of a side call's context the fake model reads. */
interface Context {
	messages: { content: { text?: string }[] }[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface FakePiOptions {
	cwd: string;
	/** pi's session name (`/name`): the name in ttt's session bar. */
	name?: string;
	/** Characters per chunk, and the time between chunks: how fast the "model" streams a helpi! answer. */
	chunk?: number;
	stepMs?: number;
	log?: (line: string) => void;
	/** The "model" for helpi!: the whole reply to a question, streamed in chunks. */
	answer?: (prompt: string) => string;
	/** How long the "model" thinks before its first chunk (default 4 steps). */
	thinkMs?: number;
}

export class FakePi {
	readonly cwd: string;
	/** The messages pi's agent got from the extension: helpi! questions it hands over. */
	readonly inbox: string[] = [];
	/** The prompts of the helpi! side calls. */
	readonly asked: string[] = [];
	private readonly handlers = new Map<string, Handler[]>();
	private readonly tools = new Map<string, Tool>();
	private readonly ctx: unknown;
	private readonly chunk: number;
	private readonly stepMs: number;
	private readonly thinkMs: number;
	private readonly log: (line: string) => void;
	private calls = 0;
	private idle = true;

	constructor(options: FakePiOptions) {
		this.cwd = options.cwd;
		this.chunk = options.chunk ?? 12;
		this.stepMs = options.stepMs ?? 25;
		this.thinkMs = options.thinkMs ?? this.stepMs * 4;
		this.log = options.log ?? (() => {});
		const pi = {
			on: (name: string, h: Handler) => this.handlers.set(name, [...(this.handlers.get(name) ?? []), h]),
			registerTool: (t: Tool) => this.tools.set(t.name, t),
			getSessionName: () => options.name,
			sendUserMessage: (text: string) => this.inbox.push(text),
		};
		symbiosis(pi as never);
		const answer = options.answer ?? (() => 'note\nThe fake pi has no model.');
		this.ctx = {
			cwd: this.cwd,
			isIdle: () => this.idle,
			abort: () => {
				this.aborts++;
			},
			sessionManager: { getBranch: () => [] },
			model: { id: 'fake' },
			modelRegistry: { streamSimple: (_model: unknown, context: Context, options?: { signal?: AbortSignal }) => this.stream(answer, context, options?.signal) },
		};
	}

	/** How often ctrl+k q (or anything else) asked this pi to stop its turn. */
	aborts = 0;

	/** A dialog, as a guard's "Allow?": pi waits on it until `dialogEnd()`. */
	async dialog(title: string): Promise<void> {
		await this.fire('ui_prompt_start', { type: 'ui_prompt_start', reason: 'ui_prompt', kind: 'confirm', title });
	}

	async dialogEnd(): Promise<void> {
		await this.fire('ui_prompt_end', { type: 'ui_prompt_end', reason: 'ui_prompt', kind: 'confirm' });
	}

	/** Runs the handlers in order; returns the first `{ block }` one gives, as pi stops there. */
	async fire(name: string, event: unknown = {}): Promise<{ block?: boolean; reason?: string } | undefined> {
		for (const h of this.handlers.get(name) ?? []) {
			const result = (await h(event, this.ctx)) as { block?: boolean; reason?: string } | undefined;
			if (result?.block) return result;
		}
		return undefined;
	}

	async start(): Promise<void> {
		await this.fire('session_start');
	}

	async stop(): Promise<void> {
		await this.fire('session_shutdown');
	}

	/** The id the plugin knows this session by, from its record in the plugin folder. */
	sessionId(): string | undefined {
		try {
			const records = readdirSync(join(pluginDir(), 'sessions'));
			return records.find((f) => f.startsWith(`${process.pid}-`) && f.endsWith('.json'))?.slice(0, -5);
		} catch {
			return undefined;
		}
	}

	/** The session the editor follows now, from the plugin's state file. */
	owner(): string | undefined {
		try {
			return JSON.parse(readFileSync(join(pluginDir(), 'ttt.json'), 'utf-8')).owner;
		} catch {
			return undefined;
		}
	}

	/** Waits until the editor follows this session; false after `ms` (no limit when 0). */
	async waitOwner(ms = 0): Promise<boolean> {
		const until = ms > 0 ? Date.now() + ms : Infinity;
		while (Date.now() < until) {
			const id = this.sessionId();
			if (id && this.owner() === id) return true;
			await sleep(100);
		}
		return false;
	}

	/** A side call's stream: the answer in chunks, as pi's model registry streams it. */
	private async *stream(answer: (prompt: string) => string, context: Context, signal?: AbortSignal): AsyncGenerator<unknown> {
		const prompt = context.messages[0]?.content[0]?.text ?? '';
		this.asked.push(prompt);
		const reply = answer(prompt);
		this.log(`helpi!: answering (${reply.split('\n')[0]})`);
		await sleep(this.thinkMs);
		for (let i = 0; i < reply.length; i += this.chunk) {
			if (signal?.aborted) {
				yield { type: 'error', reason: 'aborted', error: { errorMessage: 'aborted' } };
				return;
			}
			yield { type: 'text_delta', delta: reply.slice(i, i + this.chunk) };
			await sleep(this.stepMs);
		}
		yield { type: 'done', reason: 'stop' };
	}

	async beginTurn(): Promise<void> {
		this.idle = false;
		await this.fire('agent_start');
	}

	async endTurn(): Promise<void> {
		await this.fire('turn_end');
		await this.fire('agent_end');
		this.idle = true;
	}

	/** The model calls the plan tool. */
	async plan(...steps: [string, StepState, string[]?][]): Promise<void> {
		await this.tools.get('plan')?.execute(`plan-${++this.calls}`, { steps: steps.map(([text, state, files]) => ({ text, state, ...(files ? { files } : {}) })) });
	}

	/** The model writes a whole file. */
	async write(path: string, content: string, why?: string): Promise<CallResult> {
		return this.call('write', { path, content, ...(why ? { why } : {}) });
	}

	/** The model edits a file with pi's edit tool. */
	async edit(path: string, edits: Edit[], why?: string): Promise<CallResult> {
		return this.call('edit', { path, edits, ...(why ? { why } : {}) });
	}

	/** The model calls propose; resolves with the tool's answer once the developer answered. */
	async propose(proposal: Proposal, signal?: AbortSignal): Promise<string> {
		const result = await this.tools.get('propose')?.execute(`propose-${++this.calls}`, proposal, signal, undefined, this.ctx);
		const text = result?.content?.[0]?.text ?? '';
		this.log(`propose ${proposal.kind} ${proposal.target}: ${text}`);
		return text;
	}

	/**
	 * The model runs a tool the extension does not register (bash): `run` is
	 * its work. Resolves with the text the model gets back.
	 */
	async other(name: string, run: () => void): Promise<string> {
		const id = `call-${++this.calls}`;
		const blocked = await this.fire('tool_call', { toolCallId: id, toolName: name, input: {} });
		if (blocked) return blocked.reason ?? '';
		run();
		let content: { type: string; text?: string }[] = [{ type: 'text', text: 'ran' }];
		for (const h of this.handlers.get('tool_result') ?? []) {
			const changed = (await h({ toolCallId: id, toolName: name, input: {}, content, isError: false }, this.ctx)) as { content?: typeof content } | undefined;
			if (changed?.content) content = changed.content;
		}
		const text = content.map((c) => c.text ?? '').join('\n');
		this.log(`${name}: ${text}`);
		return text;
	}

	/** Runs one tool call, like pi does. */
	private async call(name: 'write' | 'edit', args: { path: string } & Record<string, unknown>): Promise<CallResult> {
		const id = `call-${++this.calls}`;
		const tool = this.tools.get(name);
		if (!tool) throw new Error(`fake pi: the extension registers no ${name} tool`);
		const input = tool.prepareArguments ? tool.prepareArguments(args) : args;
		const blocked = await this.fire('tool_call', { toolCallId: id, toolName: name, input });
		const file = args.path.startsWith('/') ? args.path : join(this.cwd, args.path);
		if (blocked) {
			// pi fires no tool_result for a blocked call.
			this.log(`${name} ${relative(this.cwd, file)}: blocked`);
			return { blocked: blocked.reason ?? '' };
		}
		let details: unknown;
		let error: string | undefined;
		try {
			details = (await tool.execute(id, input, undefined, undefined, this.ctx)).details;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			this.log(error);
		}
		await this.fire('tool_result', { toolCallId: id, toolName: name, input, isError: error !== undefined, details });
		return error === undefined ? {} : { error };
	}
}
