// The side call: one question to the session's model, outside pi's
// conversation. helpi! (core/help.ts) and ask (core/ask.ts) both use it.
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

/** At most one text write per call in this time: the plugin polls every 40 ms. */
export const FLUSH_MS = 40;

/**
 * Asks the model `prompt` under `system` and calls `onText` with all the
 * text so far on each delta. Returns the whole text. Throws `stopped` when
 * `signal` aborts, and the model's own message when it fails.
 */
export async function streamText(
	ctx: ExtensionContext,
	system: string,
	prompt: string,
	signal: AbortSignal,
	onText: (raw: string) => void,
): Promise<string> {
	const model = ctx.model;
	if (!model) throw new Error('pi has no model');
	const stream = ctx.modelRegistry.streamSimple(
		model,
		{ systemPrompt: system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }] },
		{ signal },
	);
	let raw = '';
	for await (const ev of stream) {
		if (signal.aborted) break;
		if (ev.type === 'text_delta') {
			raw += ev.delta;
			onText(raw);
		} else if (ev.type === 'error') {
			throw new Error(ev.error.errorMessage || ev.reason);
		}
	}
	if (signal.aborted) throw new Error('stopped');
	return raw;
}

/** Calls `send` at most once per FLUSH_MS while text comes in, and once more at the end. */
export class Flush {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly send: (final: boolean) => void;

	constructor(send: (final: boolean) => void) {
		this.send = send;
	}

	/** Text came in: send it soon. */
	poke(): void {
		this.timer ??= setTimeout(() => this.now(false), FLUSH_MS);
	}

	/** Send now. */
	now(final: boolean): void {
		this.cancel();
		this.send(final);
	}

	cancel(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
	}
}
