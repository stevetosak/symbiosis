// symbiosis, the pi side: streams each write and edit into the ttt editor
// while the model writes it, and follows the result.
//
// One pi session at a time: the last writer wins. Without the plugin folder
// (ttt or the plugin not installed) this extension writes nothing.
import { existsSync, readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Channel } from './channel.ts';
import { findMarkers, suggestionMessage } from './suggest.ts';
import { absolutePath, adler32, type ChannelEvent, firstLine, pluginDir, type Tool, Tracker } from './stream.ts';

/** At most one text write per call in this time: the plugin polls every 40 ms. */
const FLUSH_MS = 40;

interface Live {
	tracker: Tracker;
	args: Record<string, unknown>;
	timer?: ReturnType<typeof setTimeout>;
	last: number;
}

function isTool(name: unknown): name is Tool {
	return name === 'write' || name === 'edit';
}

export default function symbiosis(pi: ExtensionAPI) {
	const channel = new Channel(pluginDir());
	const live = new Map<string, Live>();
	let last: { path: string; line: number } | undefined;
	let session: ExtensionContext | undefined;
	let lastRequest: string | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;

	/** ctrl+k e in ttt: every AI!/AI? marker goes to the agent as one message. */
	function checkRequest(): void {
		if (!session || !channel.enabled()) return;
		const request = channel.request();
		if (!request || request.id === lastRequest) return;
		lastRequest = request.id;
		const markers = findMarkers(session.cwd, request.path ? [request.path] : []);
		const busy = !session.isIdle();
		channel.emit({ op: 'sent', count: markers.length, busy });
		if (markers.length === 0) return;
		const text = suggestionMessage(markers, session.cwd);
		if (busy) pi.sendUserMessage(text, { deliverAs: 'followUp' });
		else pi.sendUserMessage(text);
	}

	pi.on('session_start', (_event, ctx) => {
		session = ctx;
		// A request from before this session is old: do not send it again.
		lastRequest = channel.enabled() ? channel.request()?.id : undefined;
		clearInterval(poll);
		poll = setInterval(checkRequest, 250);
		poll.unref?.();
	});

	pi.on('session_shutdown', () => {
		clearInterval(poll);
		poll = undefined;
	});

	/** Sends what changed since the last flush, starting the call once its path is complete. */
	function flush(entry: Live, cwd: string, final: boolean): void {
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
			events.push({ op: 'start', call: t.id, tool: t.tool, path: t.path, sum: existsSync(t.path) ? adler32(readFileSync(t.path)) : null });
		}
		events.push(...t.update(entry.args, final));
		channel.emit(...events);
	}

	/** Every call that started but will not run gets its preview undone. */
	function abortOpen(): void {
		for (const [id, entry] of live) {
			clearTimeout(entry.timer);
			if (entry.tracker.started && !entry.tracker.readied) channel.emit({ op: 'abort', call: id });
		}
		live.clear();
	}

	pi.on('agent_start', () => {
		if (channel.enabled()) channel.rotate();
	});

	pi.on('message_update', (event, ctx) => {
		if (!channel.enabled()) return;
		const e = event.assistantMessageEvent;
		if (e.type !== 'toolcall_start' && e.type !== 'toolcall_delta' && e.type !== 'toolcall_end') return;
		const block = e.type === 'toolcall_end' ? e.toolCall : e.partial.content[e.contentIndex];
		if (!block || block.type !== 'toolCall' || !isTool(block.name)) return;
		let entry = live.get(block.id);
		if (!entry) {
			if (channel.plugin().pinned) return;
			entry = { tracker: new Tracker(block.id, block.name), args: {}, last: 0 };
			live.set(block.id, entry);
		}
		entry.args = (block.arguments ?? {}) as Record<string, unknown>;
		const due = Date.now() - entry.last >= FLUSH_MS;
		if (e.type === 'toolcall_end' || due) flush(entry, ctx.cwd, e.type === 'toolcall_end');
		else if (!entry.timer) {
			const pending = entry;
			pending.timer = setTimeout(() => flush(pending, ctx.cwd, false), FLUSH_MS);
		}
	});

	// Just before the tool runs: the final text, then `ready`, then wait until
	// the plugin has undone its preview, so the write lands on a clean buffer
	// and ttt reloads it.
	pi.on('tool_call', async (event, ctx) => {
		if (!isTool(event.toolName) || !channel.enabled()) return undefined;
		const entry = live.get(event.toolCallId);
		if (!entry) return undefined;
		entry.args = event.input as Record<string, unknown>;
		flush(entry, ctx.cwd, true);
		if (!entry.tracker.started) return undefined;
		entry.tracker.readied = true;
		channel.emit({ op: 'ready', call: entry.tracker.id });
		if (channel.plugin().alive) await channel.waitAck(entry.tracker.id);
		return undefined;
	});

	pi.on('tool_result', (event, ctx) => {
		if (!isTool(event.toolName) || !channel.enabled()) return undefined;
		const path = (event.input as { path?: unknown }).path;
		if (typeof path !== 'string' || path === '') return undefined;
		live.delete(event.toolCallId);
		const done = { op: 'done' as const, call: event.toolCallId, tool: event.toolName, path: absolutePath(path, ctx.cwd), line: firstLine(event.toolName, event.details), ok: !event.isError };
		if (done.ok) last = { path: done.path, line: done.line };
		channel.emit(done);
		return undefined;
	});

	pi.on('turn_end', () => {
		if (channel.enabled()) abortOpen();
	});

	pi.on('agent_end', () => {
		if (!channel.enabled()) return;
		abortOpen();
		if (last) channel.emit({ op: 'stop', ...last });
	});
}
