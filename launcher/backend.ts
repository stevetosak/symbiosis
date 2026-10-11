// The bridge between the pi that symbiosis runs (RPC mode) and the ttt
// plugin, through two files in the plugin's folder (a ttt plugin can read and
// write only there):
//
//   backends/<id>/ui.json   the launcher writes: a heartbeat, pi's state, the
//                           dialog pi waits on, and pi's notices.
//   backends/<id>/ttt.json  the plugin writes: your prompts and your answers
//                           to dialogs, each with an id. The launcher acts on
//                           an id once.
//
// ttt gets <id> in the environment variable SYMBIOSIS_BACKEND, so each ttt
// talks only to the pi that its own `symbiosis` started.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Json } from './rpc.ts';

export type Method = 'confirm' | 'select' | 'input' | 'editor';

/** A dialog of pi's, as the plugin shows it. */
export interface Dialog {
	id: string;
	method: Method;
	title: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	/** Unix ms when pi stops waiting and takes its default. */
	until?: number;
}

export interface Notice {
	id: string;
	text: string;
	level: 'info' | 'warning' | 'error';
}

export interface Answer {
	id: string;
	value?: string;
	confirmed?: boolean;
	cancelled?: boolean;
}

export interface Prompt {
	id: string;
	text: string;
}

export type PiState = 'starting' | 'ready' | 'exited';

const MAX_NOTICES = 20;

function isMethod(m: unknown): m is Method {
	return m === 'confirm' || m === 'select' || m === 'input' || m === 'editor';
}

/** A dialog request of pi's; undefined for every other record. */
export function toDialog(record: Json, now: number): Dialog | undefined {
	if (record.type !== 'extension_ui_request' || typeof record.id !== 'string' || !isMethod(record.method)) return undefined;
	const d: Dialog = { id: record.id, method: record.method, title: typeof record.title === 'string' ? record.title : 'pi asks' };
	if (typeof record.message === 'string') d.message = record.message;
	if (Array.isArray(record.options)) d.options = record.options.filter((o): o is string => typeof o === 'string');
	if (typeof record.placeholder === 'string') d.placeholder = record.placeholder;
	if (typeof record.prefill === 'string') d.prefill = record.prefill;
	if (typeof record.timeout === 'number' && record.timeout > 0) d.until = now + record.timeout;
	return d;
}

/** A notify request of pi's; undefined for every other record. */
export function toNotice(record: Json): Notice | undefined {
	if (record.type !== 'extension_ui_request' || record.method !== 'notify' || typeof record.message !== 'string') return undefined;
	const level = record.notifyType === 'warning' ? 'warning' : record.notifyType === 'error' ? 'error' : 'info';
	return { id: String(record.id ?? ''), text: record.message, level };
}

/** The extension_ui_response for your answer. A value pi cannot use counts as cancelled. */
export function toResponse(dialog: Dialog, answer: Answer): Json {
	const cancelled = { type: 'extension_ui_response', id: dialog.id, cancelled: true };
	if (answer.cancelled) return cancelled;
	if (dialog.method === 'confirm') return typeof answer.confirmed === 'boolean' ? { type: 'extension_ui_response', id: dialog.id, confirmed: answer.confirmed } : cancelled;
	if (typeof answer.value !== 'string') return cancelled;
	if (dialog.method === 'select' && !(dialog.options ?? []).includes(answer.value)) return cancelled;
	return { type: 'extension_ui_response', id: dialog.id, value: answer.value };
}

export interface Pi {
	send(record: Json): void;
	request(command: Json, timeoutMs?: number): Promise<unknown>;
}

export class Backend {
	readonly dir: string;
	/** pi's dialogs, oldest first; the plugin shows the first. */
	private dialogs: Dialog[] = [];
	private notices: Notice[] = [];
	private done = new Set<string>();
	private working = false;
	private state: PiState = 'starting';
	private pi: Pi | undefined;
	private readonly now: () => number;
	private written = '';

	constructor(dir: string, now: () => number = Date.now) {
		this.dir = dir;
		this.now = now;
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		this.write();
	}

	attach(pi: Pi): void {
		this.pi = pi;
	}

	setState(state: PiState): void {
		this.state = state;
		if (state === 'exited') this.dialogs = [];
		this.write();
	}

	notice(text: string, level: Notice['level'] = 'info'): void {
		this.notices = [...this.notices, { id: `l${this.now()}-${this.notices.length}`, text, level }].slice(-MAX_NOTICES);
		this.write();
	}

	/** A record from pi that is not a response. */
	handle(record: Json): void {
		const dialog = toDialog(record, this.now());
		if (dialog) {
			this.dialogs.push(dialog);
			this.write();
			return;
		}
		const notice = toNotice(record);
		if (notice) {
			this.notices = [...this.notices, notice].slice(-MAX_NOTICES);
			this.write();
			return;
		}
		if (record.type === 'agent_start') this.working = true;
		else if (record.type === 'agent_settled') this.working = false;
		else return;
		this.write();
	}

	/** Every ~100 ms: acts on new prompts and answers, drops dialogs pi gave up on, beats. */
	tick(): void {
		const from = this.readTtt();
		for (const answer of from.answers) {
			if (this.done.has(answer.id)) continue;
			this.done.add(answer.id);
			const i = this.dialogs.findIndex((d) => d.id === answer.id);
			if (i < 0) continue;
			const [dialog] = this.dialogs.splice(i, 1);
			this.pi?.send(toResponse(dialog, answer));
		}
		for (const prompt of from.prompts) {
			if (this.done.has(prompt.id)) continue;
			this.done.add(prompt.id);
			this.prompt(prompt.text);
		}
		const now = this.now();
		this.dialogs = this.dialogs.filter((d) => d.until === undefined || d.until > now);
		this.write();
	}

	/** Sends a prompt; while pi works it waits as a follow-up. */
	prompt(text: string): void {
		if (!this.pi || this.state !== 'ready') {
			this.notice('pi is not running: the prompt was not sent', 'error');
			return;
		}
		const command: Json = { type: 'prompt', message: text };
		if (this.working) command.streamingBehavior = 'followUp';
		this.pi.request(command).catch((error: unknown) => this.notice(`pi did not take the prompt: ${error instanceof Error ? error.message : String(error)}`, 'error'));
	}

	remove(): void {
		rmSync(this.dir, { recursive: true, force: true });
	}

	private readTtt(): { prompts: Prompt[]; answers: Answer[] } {
		let raw: { prompts?: unknown; answers?: unknown };
		try {
			raw = JSON.parse(readFileSync(join(this.dir, 'ttt.json'), 'utf-8'));
		} catch {
			return { prompts: [], answers: [] };
		}
		const list = <T>(v: unknown, ok: (x: any) => boolean): T[] => (Array.isArray(v) ? v.filter((x) => x && typeof x.id === 'string' && ok(x)) : []);
		return {
			prompts: list<Prompt>(raw?.prompts, (x) => typeof x.text === 'string' && x.text.trim() !== ''),
			answers: list<Answer>(raw?.answers, () => true),
		};
	}

	/** Writes ui.json when it changed, and once a second as a heartbeat. */
	private write(): void {
		const t = Math.floor(this.now() / 1000);
		const text = JSON.stringify({ v: 1, t, pi: this.state, working: this.working, dialog: this.dialogs[0] ?? null, notices: this.notices });
		if (text === this.written) return;
		this.written = text;
		const path = join(this.dir, 'ui.json');
		try {
			writeFileSync(`${path}.tmp`, text);
			renameSync(`${path}.tmp`, path);
		} catch {
			// The plugin folder went away (ttt uninstalled the plugin); pi goes on.
		}
	}
}
