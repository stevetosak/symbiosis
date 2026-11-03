// symbiosis, the pi side: streams each write and edit to the ttt editor while
// the model writes it (the editor types it at the operator's speed when it
// follows pi), and keeps the changes for it to show. pi never waits for the editor.
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
// of pi, so another agent or another channel can use them: the session record,
// the events and the change log are core/agent/agent.ts.
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { AgentSide } from '../core/agent/agent.ts';
import { absolutePath, firstLine } from '../core/call.ts';
import { askMessage, HELP_SYSTEM, helpPrompt, lastAssistantText, parseAnswer } from '../core/help.ts';
import { CAPABILITIES, type HelpRequest, type Tool } from '../core/protocol.ts';
import { Asking } from './ask.ts';
import { Filling, PROPOSE_DESCRIPTION, PROPOSE_PARAMETERS, type ProposeParams } from './fill.ts';
import { cleanSteps, PLAN_DESCRIPTION, prepareArguments, PLAN_GUIDELINES, PLAN_PARAMETERS, PLAN_SNIPPET, planFromBranch, planSummary } from './plan.ts';
import { Reviewing } from './review.ts';
import { syncTttPlugin } from './setup.ts';
import { Flush, streamText } from './side.ts';
import { tools, whyOf } from './tools.ts';

function isTool(name: unknown): name is Tool {
	return name === 'write' || name === 'edit';
}

export default function symbiosis(pi: ExtensionAPI) {
	let session: ExtensionContext | undefined;
	const side = new AgentSide({
		id: `${process.pid}-${Date.now().toString(36)}`,
		agent: 'pi',
		can: [...CAPABILITIES],
		cwd: process.cwd(),
		pid: process.pid,
		host: {
			stop() {
				if (session && !session.isIdle()) session.abort();
			},
			quit() {
				session?.shutdown();
			},
		},
	});
	const { channel, id, record } = side;
	let lastHelp: string | undefined;
	let helping: { id: string; abort: AbortController } | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;

	const filling = new Filling({
		channel,
		id,
		owner: () => side.owner(),
		scope: () => side.plugin().scope,
		publish(fill) {
			record.fill = fill;
			side.beat();
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
			side.beat();
		},
	});

	const asking = new Asking({ channel, id, plan: () => record.plan, whys: (path) => side.changes.whys(path) });

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
			record.plan = cleanSteps(params, (path) => absolutePath(path, record.cwd));
			side.beat();
			return { content: [{ type: 'text' as const, text: planSummary(record.plan) }], details: { steps: record.plan } };
		},
	});

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
		side.begin(ctx.cwd);
		// After /reload or a resume: the last plan in this session comes back.
		try {
			record.plan = planFromBranch(ctx.sessionManager.getBranch()) ?? [];
		} catch {
			record.plan = [];
		}
		// A question from before this session is old: do not answer it again.
		lastHelp = channel.enabled() ? channel.help()?.id : undefined;
		filling.skipOld();
		asking.skipOld();
		reviewing.skipOld();
		record.model = ctx.model?.id ?? null;
		record.title = pi.getSessionName?.() ?? null;
		side.beat();
		clearInterval(poll);
		// helpi! is to be fast: its file is read every 100 ms; a beat each second.
		poll = setInterval(() => {
			checkHelp();
			side.poll();
			asking.poll(ctx);
			reviewing.poll();
			filling.poll(ctx.cwd).catch(() => undefined);
		}, 100);
		poll.unref?.();
	});

	pi.on('model_select', (event) => {
		record.model = event.model?.id ?? null;
		side.beat();
	});

	// A dialog of any extension (a guard's "Allow?"): pi waits for the operator,
	// who may be in ttt. The status bar says so.
	pi.on('ui_prompt_start', (event) => {
		record.waiting = event.title || event.kind;
		side.beat();
	});

	pi.on('ui_prompt_end', () => {
		record.waiting = null;
		side.beat();
	});

	pi.on('session_info_changed', (event) => {
		record.title = event.name ?? null;
		side.beat();
	});

	pi.on('session_shutdown', () => {
		helping?.abort.abort();
		asking.stop();
		clearInterval(poll);
		poll = undefined;
		side.end();
	});

	pi.on('agent_start', () => side.turnStart());

	// The model writes a write or edit call: its text goes to the editor as it
	// grows, at most once per FLUSH_MS. Only the owner streams.
	pi.on('message_update', (event, ctx) => {
		if (!channel.enabled()) return;
		const e = event.assistantMessageEvent;
		if (e.type !== 'toolcall_start' && e.type !== 'toolcall_delta' && e.type !== 'toolcall_end') return;
		const block = e.type === 'toolcall_end' ? e.toolCall : e.partial.content[e.contentIndex];
		if (!block || block.type !== 'toolCall' || !isTool(block.name)) return;
		side.stream(block.id, block.name, (block.arguments ?? {}) as Record<string, unknown>, ctx.cwd, e.type === 'toolcall_end');
	});

	// Just before the tool runs. The guard comes first; a call it lets through
	// gets its final text and `ready`, and runs at once: pi never waits for the editor.
	pi.on('tool_call', async (event, ctx) => {
		if (!isTool(event.toolName)) {
			filling.keep(event.toolCallId);
			return undefined;
		}
		const blocked = await filling.check(event.toolCallId, event.toolName, event.input, ctx.cwd);
		if (blocked) {
			side.blocked(event.toolCallId, blocked.reason);
			return blocked;
		}
		side.ready(event.toolCallId, event.toolName, event.input as Record<string, unknown>, ctx.cwd);
		return undefined;
	});

	pi.on('tool_result', (event, ctx) => {
		if (!isTool(event.toolName)) {
			const undone = filling.restore(event.toolCallId, ctx.cwd);
			return undone ? { content: [...event.content, { type: 'text' as const, text: undone }], structuredContent: event.structuredContent } : undefined;
		}
		filling.ran(event.toolCallId, !event.isError);
		side.done(event.toolCallId, event.toolName, event.input as Record<string, unknown>, ctx.cwd, !event.isError, firstLine(event.toolName, event.details), whyOf(event.input));
		return undefined;
	});

	pi.on('turn_end', () => side.abortOpen());

	pi.on('agent_end', async () => {
		record.working = false;
		const landing = await filling.settle();
		if (landing) reviewing.land(landing, side.changes.whys(landing.path));
		side.turnEnd();
	});
}
