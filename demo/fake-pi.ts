// A pi without a model, for the demo and the end-to-end tests. It loads the
// real extension (pi/index.ts) and plays the events pi sends it: tool call
// arguments arrive in small JSON chunks, parsed by pi's own partial parser,
// then the tool runs (the file changes on disk) and its result comes back.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import symbiosis from '../pi/index.ts';
import { pluginDir } from '../pi/stream.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; execute: (id: string, params: unknown) => Promise<unknown> };
export type StepState = 'done' | 'now' | 'next';
export interface Edit {
	oldText: string;
	newText: string;
}

/** The part of a side call's context the fake model reads. */
interface Context {
	messages: { content: { text?: string }[] }[];
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** pi's partial JSON parser, from the newest pi install. Without one: no text until the call is complete. */
async function partialParser(): Promise<(s: string) => unknown> {
	const releases = join(homedir(), '.pi/agent/install/releases');
	const versions = existsSync(releases) ? readdirSync(releases).sort().reverse() : [];
	for (const v of versions) {
		const file = join(releases, v, 'node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js');
		if (existsSync(file)) return ((await import(file)) as { parseStreamingJson: (s: string) => unknown }).parseStreamingJson;
	}
	return (s) => {
		try {
			return JSON.parse(s);
		} catch {
			return {};
		}
	};
}

export interface FakePiOptions {
	cwd: string;
	/** pi's session name (`/name`): the name in ttt's session bar. */
	name?: string;
	/** Characters per JSON chunk, and the time between chunks: how fast the "model" streams. */
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
	private parse: (s: string) => unknown = () => ({});
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

	async fire(name: string, event: unknown = {}): Promise<void> {
		for (const h of this.handlers.get(name) ?? []) await h(event, this.ctx);
	}

	async start(): Promise<void> {
		this.parse = await partialParser();
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
	async plan(...steps: [string, StepState][]): Promise<void> {
		await this.tools.get('plan')?.execute(`plan-${++this.calls}`, { steps: steps.map(([text, state]) => ({ text, state })) });
	}

	/** The model writes a whole file. */
	async write(path: string, content: string): Promise<void> {
		await this.call('write', { path, content }, (file) => {
			writeFileSync(file, content);
			return undefined;
		});
	}

	/** The model edits a file: each oldText must be in it once, like pi's edit tool asks. */
	async edit(path: string, edits: Edit[]): Promise<void> {
		await this.call('edit', { path, edits }, (file) => {
			let text = readFileSync(file, 'utf-8');
			let first = Infinity;
			for (const e of edits) {
				const at = text.indexOf(e.oldText);
				if (at < 0) throw new Error(`edit: ${path}: text not found: ${e.oldText.slice(0, 40)}`);
				first = Math.min(first, text.slice(0, at).split('\n').length);
				text = text.slice(0, at) + e.newText + text.slice(at + e.oldText.length);
			}
			writeFileSync(file, text);
			return { firstChangedLine: first === Infinity ? 1 : first };
		});
	}

	/** Streams one tool call, then runs it, like pi does. */
	private async call(name: 'write' | 'edit', args: { path: string }, run: (file: string) => unknown): Promise<void> {
		const id = `call-${++this.calls}`;
		const json = JSON.stringify(args);
		for (let i = this.chunk; i < json.length + this.chunk; i += this.chunk) {
			const partial = { content: [{ type: 'toolCall', id, name, arguments: this.parse(json.slice(0, i)) }] };
			await this.fire('message_update', { assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '', partial } });
			await sleep(this.stepMs);
		}
		const toolCall = { type: 'toolCall', id, name, arguments: args };
		await this.fire('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall } });
		const t = Date.now();
		// The plugin types the preview at its own speed; pi waits here until it is all on screen.
		await this.fire('tool_call', { toolCallId: id, toolName: name, input: args });
		const file = args.path.startsWith('/') ? args.path : join(this.cwd, args.path);
		this.log(`${name} ${relative(this.cwd, file)}: pi waited ${((Date.now() - t) / 1000).toFixed(1)} s for the editor`);
		let details: unknown;
		let isError = false;
		try {
			details = run(file);
		} catch (e) {
			isError = true;
			this.log(String(e));
		}
		await this.fire('tool_result', { toolCallId: id, toolName: name, input: args, isError, details });
	}
}
