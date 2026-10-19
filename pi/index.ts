// symbiosis, the pi side: tells the ttt editor which files pi writes and edits,
// and keeps the changes for it to show. pi never waits for the editor.
//
// Many pi sessions can run. Each writes a session record; the plugin picks the
// one the editor follows (the owner) and only the owner writes events and
// answers helpi! questions (core/help.ts). Without the plugin folder (ttt or the plugin not
// installed) this extension writes nothing.
//
// While a stub or a described function is filled (helpi! in ttt), every write and edit is checked by
// the guard first (pi/fill.ts); pi's own edit and write are registered again
// with a `why` argument and one call at a time (pi/tools.ts).
//
// This file wires core/ into pi. The rules live in core/, which knows nothing
// of pi, so another agent or another channel can use them.
import { basename, join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Channel } from '../core/channel/channel.ts';
import { FileChannel, pluginDir } from '../core/channel/file.ts';
import { askMessage, HELP_SYSTEM, helpPrompt, lastAssistantText, parseAnswer } from '../core/help.ts';
import { type HelpRequest, type PluginState, PROTOCOL, type Session, type Tool } from '../core/protocol.ts';
import { paneOf } from '../core/session.ts';
import { absolutePath, firstLine } from '../core/call.ts';
import { Changes } from './changes.ts';
import { Filling, PROPOSE_DESCRIPTION, PROPOSE_PARAMETERS, type ProposeParams } from './fill.ts';
import { cleanSteps, PLAN_DESCRIPTION, prepareArguments, PLAN_GUIDELINES, PLAN_PARAMETERS, PLAN_SNIPPET, planFromBranch, planSummary } from './plan.ts';
import { syncTttPlugin } from './setup.ts';
import { Asking } from './ask.ts';
import { Reviewing } from './review.ts';
import { Flush, streamText } from './side.ts';
import { tools, whyOf } from './tools.ts';

/** The files a session record lists as written by it. */
const MAX_FILES = 20;

function isTool(name: unknown): name is Tool {
	return name === 'write' || name === 'edit';
}

export default function symbiosis(pi: ExtensionAPI) {
	const channel: Channel = new FileChannel(pluginDir());
	const changes = new Changes(join(pluginDir(), 'changes'));
	// The run (agent_start to agent_end) whose changes are kept, and the run now.
	let changesRun = 0;
	let run = 0;
	let last: { path: string; line: number } | undefined;
	let session: ExtensionContext | undefined;
	let lastHelp: string | undefined;
	let lastStop: string | undefined;
	let lastClose: string | undefined;
	let helping: { id: string; abort: AbortController } | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;
	let ticks = 0;
	const id = `${process.pid}-${Date.now().toString(36)}`;
	const record: Session = {
		id,
		version: PROTOCOL,
		...paneOf(process.env),
		model: null,
		waiting: null,
		cwd: process.cwd(),
		name: basename(process.cwd()),
		pid: process.pid,
		t: 0,
		active: 0,
		working: false,
		plan: [],
		files: [],
		title: null,
		fill: null,
		review: [],
	};

	/** pi writes `path`: the editor follows this session for it. Beats at once,
	 * so the session record has the file before the editor opens it. */
	function wrote(path: string): void {
		if (record.files[record.files.length - 1] === path) return;
		record.files = [...record.files.filter((p) => p !== path), path].slice(-MAX_FILES);
		beat();
	}

	const filling = new Filling({
		channel,
		id,
		owner: () => owner(),
		scope: () => plugin().scope,
		publish(fill) {
			record.fill = fill;
			beat();
		},
		send(text) {
			if (!session || session.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: 'followUp' });
		},
	});

	const reviewing = new Reviewing({
		channel,
		id,
		publish(list) {
			record.review = list;
			beat();
		},
	});

	const asking = new Asking({ channel, id, plan: () => record.plan, whys: (path) => changes.whys(path) });

	for (const tool of tools(process.cwd())) pi.registerTool(tool as never);

	pi.registerTool({
		name: 'propose',
		label: 'Propose',
		description: PROPOSE_DESCRIPTION,
		promptSnippet: 'Ask the developer for a change the symbiosis guard blocked while you fill a stub or write a described function',
		// A JSON schema: pi takes it as it takes TypeBox's (which builds the same).
		parameters: PROPOSE_PARAMETERS as never,
		executionMode: 'sequential',
		async execute(call: string, params: ProposeParams, signal: AbortSignal | undefined, _update: unknown, ctx: ExtensionContext) {
			const text = await filling.propose(call, params, ctx?.cwd ?? process.cwd(), signal);
			return { content: [{ type: 'text' as const, text }], details: undefined };
		},
	});

	// pi's plan, shown in ttt as the timeline. The tool only records it: the
	// next heartbeat carries it to the plugin.
	pi.registerTool({
		name: 'plan',
		label: 'Plan',
		description: PLAN_DESCRIPTION,
		promptSnippet: PLAN_SNIPPET,
		promptGuidelines: PLAN_GUIDELINES,
		// Plain JSON Schema: pi accepts it, and the extension needs no typebox.
		parameters: PLAN_PARAMETERS as any,
		prepareArguments,
		async execute(_id: string, params: unknown) {
			record.plan = cleanSteps(params);
			beat();
			return { content: [{ type: 'text' as const, text: planSummary(record.plan) }], details: { steps: record.plan } };
		},
	});

	function beat(): void {
		record.t = Date.now() / 1000;
		try {
			channel.writeSession(record);
		} catch {
			// A missed heartbeat is not worth failing a turn for.
		}
	}

	// The plugin's state, read at most every 200 ms: tool calls can come in bursts.
	let state: PluginState = { alive: false, scope: 'stub' };
	let stateAt = 0;
	function plugin(): PluginState {
		if (Date.now() - stateAt > 200) {
			state = channel.plugin();
			stateAt = Date.now();
		}
		return state;
	}

	/** True when the editor follows this session: only then does it write events. */
	function owner(): boolean {
		if (!channel.enabled()) return false;
		const p = plugin();
		return p.alive && p.owner === id;
	}

	/** ctrl+k q in ttt: stop this session's turn. */
	function checkStop(): void {
		if (!session || !channel.enabled()) return;
		const request = channel.stop();
		if (!request || request.to !== id || request.id === lastStop) return;
		lastStop = request.id;
		if (!session.isIdle()) session.abort();
	}

	/** `symbiosis close`: this session quits, as /quit does. */
	function checkClose(): void {
		if (!session || !channel.enabled()) return;
		const request = channel.close();
		if (!request || request.to !== id || request.id === lastClose) return;
		lastClose = request.id;
		session.shutdown();
	}

	/** helpi! in ttt: a question for this session, or Esc on the one it answers. */
	function checkHelp(): void {
		if (!session || !channel.enabled()) return;
		const request = channel.help();
		if (!request || request.to !== id) return;
		if (request.cancel) {
			if (helping?.id === request.id) helping.abort.abort();
			return;
		}
		if (request.id === lastHelp) return;
		lastHelp = request.id;
		void answer(request, session);
	}

	/**
	 * Asks the session's model in a side call, outside the conversation, and
	 * streams the answer to the editor as it comes. An `ask` answer sends the
	 * question to this session's agent instead.
	 */
	async function answer(request: HelpRequest, ctx: ExtensionContext): Promise<void> {
		helping?.abort.abort();
		const abort = new AbortController();
		helping = { id: request.id, abort };
		const hid = request.id;
		channel.emit({ op: 'help', id: hid, session: id });
		let raw = '';
		let started = false;
		let sent = '';
		const send = (final: boolean) => {
			const a = parseAnswer(raw, final);
			if (!a.settled || !a.kind) return;
			if (!started) {
				started = true;
				channel.emit({ op: 'help_start', id: hid, kind: a.kind, imports: a.imports });
				if (a.kind === 'ask') {
					const text = askMessage(request, ctx.cwd);
					if (ctx.isIdle()) pi.sendUserMessage(text);
					else pi.sendUserMessage(text, { deliverAs: 'followUp' });
				}
			}
			if (final) {
				channel.emit({ op: 'help_done', id: hid, text: a.body });
			} else if (a.body !== sent) {
				channel.emit({ op: 'help_text', id: hid, text: a.body });
			}
			sent = a.body;
		};
		const flush = new Flush(send);
		try {
			let lastMessage: string | undefined;
			try {
				lastMessage = lastAssistantText(ctx.sessionManager.getBranch());
			} catch {
				lastMessage = undefined;
			}
			await streamText(ctx, HELP_SYSTEM, helpPrompt(request, ctx.cwd, record.plan, lastMessage), abort.signal, (text) => {
				raw = text;
				flush.poke();
			});
			flush.now(true);
		} catch (error) {
			flush.cancel();
			const stopped = abort.signal.aborted;
			const body = parseAnswer(raw, true).body;
			channel.emit({
				op: 'help_done',
				id: hid,
				text: started ? body : '',
				...(stopped ? { stopped: true } : { error: error instanceof Error ? error.message : String(error) }),
			});
		} finally {
			if (helping?.id === hid) helping = undefined;
		}
	}

	pi.on('session_start', (_event, ctx) => {
		session = ctx;
		// The ttt plugin travels in this package: bring ttt's copy up to date.
		try {
			const synced = syncTttPlugin();
			if (synced && ctx.hasUI) {
				const how = synced.state === 'create' ? 'start ttt again and allow its permissions' : 'run "Plugins: Reload" in ttt';
				ctx.ui.notify(`symbiosis: ${synced.state === 'create' ? 'installed' : 'updated'} the ttt plugin; ${how}`, 'info');
			}
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`symbiosis: could not copy the ttt plugin: ${error instanceof Error ? error.message : String(error)}`, 'warning');
		}
		record.cwd = ctx.cwd;
		record.name = basename(ctx.cwd);
		record.active = Date.now() / 1000;
		// After /reload or a resume: the last plan in this session comes back.
		try {
			record.plan = planFromBranch(ctx.sessionManager.getBranch()) ?? [];
		} catch {
			record.plan = [];
		}
		// A question from before this session is old: do not answer it again.
		lastHelp = channel.enabled() ? channel.help()?.id : undefined;
		lastStop = channel.enabled() ? channel.stop()?.id : undefined;
		lastClose = channel.enabled() ? channel.close()?.id : undefined;
		filling.skipOld();
		asking.skipOld();
		reviewing.skipOld();
		record.model = ctx.model?.id ?? null;
		if (channel.enabled()) channel.pruneSessions();
		record.title = pi.getSessionName?.() ?? null;
		beat();
		clearInterval(poll);
		// helpi! is to be fast: its file is read every 100 ms; a beat each second.
		poll = setInterval(() => {
			checkHelp();
			checkStop();
			checkClose();
			asking.poll(ctx);
			reviewing.poll();
			filling.poll(ctx.cwd).catch(() => undefined);
			if (++ticks % 10 === 0) beat();
		}, 100);
		poll.unref?.();
	});

	pi.on('model_select', (event) => {
		record.model = event.model?.id ?? null;
		beat();
	});

	// A dialog of any extension (a guard's "Allow?"): pi waits for the operator,
	// who may be in ttt. The status bar says so.
	pi.on('ui_prompt_start', (event) => {
		record.waiting = event.title || event.kind;
		beat();
	});

	pi.on('ui_prompt_end', () => {
		record.waiting = null;
		beat();
	});

	pi.on('session_info_changed', (event) => {
		record.title = event.name ?? null;
		beat();
	});

	pi.on('session_shutdown', () => {
		helping?.abort.abort();
		asking.stop();
		clearInterval(poll);
		poll = undefined;
		channel.removeSession(id);
	});

	/** A failure to keep a diff must not fail the tool call. */
	function safely(f: () => void): void {
		try {
			f();
		} catch {
			// The diff key shows less; the work goes on.
		}
	}

	/** For ctrl+k w in ttt: the file's text before this run first changes it. Owner only. */
	function keepBefore(input: unknown, cwd: string): void {
		const path = (input as { path?: unknown })?.path;
		if (typeof path !== 'string' || path === '' || !owner()) return;
		safely(() => {
			if (changesRun !== run) {
				changes.start(id);
				changesRun = run;
			}
			changes.before(absolutePath(path, cwd));
		});
	}

	pi.on('agent_start', () => {
		record.active = Date.now() / 1000;
		record.working = true;
		run = Date.now();
		beat();
		if (owner()) channel.rotate();
	});

	// Just before the tool runs. The guard comes first; a call it lets through
	// is told to the editor and runs at once: pi never waits for the editor.
	pi.on('tool_call', async (event, ctx) => {
		if (!isTool(event.toolName)) {
			filling.keep(event.toolCallId);
			return undefined;
		}
		const blocked = await filling.check(event.toolCallId, event.toolName, event.input, ctx.cwd);
		if (blocked) return blocked;
		if (!channel.enabled()) return undefined;
		const target = (event.input as { path?: unknown })?.path;
		if (typeof target !== 'string' || target === '') return undefined;
		const path = absolutePath(target, ctx.cwd);
		wrote(path);
		keepBefore(event.input, ctx.cwd);
		if (owner()) channel.emit({ op: 'start', call: event.toolCallId, tool: event.toolName, path });
		return undefined;
	});

	pi.on('tool_result', (event, ctx) => {
		if (!isTool(event.toolName)) {
			const undone = filling.restore(event.toolCallId, ctx.cwd);
			return undone ? { content: [...event.content, { type: 'text' as const, text: undone }], structuredContent: event.structuredContent } : undefined;
		}
		filling.ran(event.toolCallId, !event.isError);
		if (!channel.enabled()) return undefined;
		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== 'string' || path === '') return undefined;
		const why = whyOf(event.input);
		if (changesRun === run) safely(() => changes.after(absolutePath(path, ctx.cwd), why));
		if (!owner()) return undefined;
		const done = { op: 'done' as const, call: event.toolCallId, tool: event.toolName, path: absolutePath(path, ctx.cwd), line: firstLine(event.toolName, event.details), ok: !event.isError, ...(why ? { why } : {}) };
		if (done.ok) last = { path: done.path, line: done.line };
		channel.emit(done);
		return undefined;
	});

	pi.on('agent_end', async () => {
		record.working = false;
		const landing = await filling.settle();
		if (landing) reviewing.land(landing, changes.whys(landing.path));
		beat();
		if (!channel.enabled()) return;
		if (last && owner()) channel.emit({ op: 'stop', ...last });
	});
}
