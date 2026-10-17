// Ask, the pi side: the developer asks about code in ttt (ctrl+k d, `why!`).
// The question comes in ask.json; the answer is one side call to the model
// (pi/side.ts) with the context core/ask.ts builds, streamed back as events.
import { mkdirSync } from 'node:fs';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ASK_SYSTEM, askPrompt, isNotesDir, parseAskAnswer } from '../core/ask.ts';
import type { Channel } from '../core/channel/channel.ts';
import type { AskRequest, Step } from '../core/protocol.ts';
import type { Outline } from '../core/syntax/outline.ts';
import { syntaxFor } from '../core/syntax/parse.ts';
import { Flush, streamText } from './side.ts';

export interface AskHost {
	channel: Channel;
	/** This session's id. */
	id: string;
	plan(): Step[];
	/** The reasons the agent gave for its changes to `path` in its last turn. */
	whys(path: string): string[];
}

/** Makes the folder for the editor's note: ttt's fs cannot. A failure shows later, when the editor cannot write. */
function makeNotesDir(dir: string): void {
	if (!isNotesDir(dir)) return;
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		// the editor tells that the note is not kept
	}
}

/** The outline of the text as it is in the buffer, or undefined when no parser fits. */
async function outlineOf(path: string, text: string): Promise<Outline | undefined> {
	if (text === '') return undefined;
	try {
		return (await syntaxFor(path))?.outline(text);
	} catch {
		return undefined;
	}
}

export class Asking {
	private readonly host: AskHost;
	private seen: string | undefined;
	private current: { id: string; abort: AbortController } | undefined;

	constructor(host: AskHost) {
		this.host = host;
	}

	/** A question from before this session is old: do not answer it again. */
	skipOld(): void {
		this.seen = this.host.channel.enabled() ? this.host.channel.ask()?.id : undefined;
	}

	/** Stops the answer in progress (the session ends). */
	stop(): void {
		this.current?.abort.abort();
	}

	/** Reads ask.json: a question for this session, or Esc on the one it answers. */
	poll(ctx: ExtensionContext): void {
		const { channel, id } = this.host;
		if (!channel.enabled()) return;
		const request = channel.ask();
		if (!request || request.to !== id) return;
		if (request.cancel) {
			if (this.current?.id === request.id) this.current.abort.abort();
			return;
		}
		if (request.id === this.seen) return;
		this.seen = request.id;
		void this.answer(request, ctx);
	}

	private async answer(request: AskRequest, ctx: ExtensionContext): Promise<void> {
		const { channel, id } = this.host;
		this.current?.abort.abort();
		const abort = new AbortController();
		this.current = { id: request.id, abort };
		makeNotesDir(request.notesDir);
		channel.emit({ op: 'ask', id: request.id, session: id });
		let raw = '';
		let sent = '';
		const flush = new Flush((final) => {
			const a = parseAskAnswer(raw, final);
			if (final) return;
			if (a.text !== sent) channel.emit({ op: 'ask_text', id: request.id, text: a.text });
			sent = a.text;
		});
		try {
			const outline = await outlineOf(request.path, request.text);
			const prompt = askPrompt(request, { outline, plan: this.host.plan(), whys: this.host.whys(request.path), cwd: ctx.cwd });
			await streamText(ctx, ASK_SYSTEM, prompt, abort.signal, (text) => {
				raw = text;
				flush.poke();
			});
			flush.cancel();
			const a = parseAskAnswer(raw, true);
			channel.emit({ op: 'ask_done', id: request.id, text: a.text, links: a.links, terms: a.terms });
		} catch (error) {
			flush.cancel();
			const a = parseAskAnswer(raw, true);
			const stopped = abort.signal.aborted;
			channel.emit({
				op: 'ask_done',
				id: request.id,
				text: a.text,
				links: a.links,
				terms: a.terms,
				...(stopped ? { stopped: true } : { error: error instanceof Error ? error.message : String(error) }),
			});
		} finally {
			if (this.current?.id === request.id) this.current = undefined;
		}
	}
}
