// Filling, the pi side: helpi! in the editor starts a fill (core/fill.ts) of
// a stub's body or of a new function under its description; each write and
// edit of the agent is checked by the guard before it runs, and the `propose`
// tool asks the developer, in the editor, for a change the guard blocks. The
// fill ends at the end of a run once the work is there, or when the developer
// releases it.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Channel } from '../core/channel/channel.ts';
import { Fill } from '../core/fill.ts';
import type { GuardResult } from '../core/guard.ts';
import type { Landing } from '../core/review.ts';
import { targetName, targetText, stayInside } from '../core/target.ts';
import { type ChannelEvent, PROPOSE_KINDS, type ProposalAnswer, type ProposeKind, type Scope, type Session } from '../core/protocol.ts';
import { namedPath, planned, realPath } from './tools.ts';

/** How often propose reads the editor's answer. */
const ANSWER_MS = 100;
/** How long the editor may not follow this session before propose gives up. */
const LOST_MS = 1500;

export const PROPOSE_DESCRIPTION =
	'Ask the developer for a change the symbiosis guard blocks while you fill a stub or write a new function under its description: a new file, a new declaration, a signature change, a new dependency, or an edit outside what you fill. Waits for the answer. An accepted proposal lets exactly that one change through, once.';

export const PROPOSE_PARAMETERS = {
	type: 'object',
	required: ['kind', 'target', 'what', 'why'],
	properties: {
		kind: { type: 'string', enum: [...PROPOSE_KINDS], description: 'The kind the guard named.' },
		target: { type: 'string', description: 'The target the guard named: a path, an import, a declaration name, or the stub\'s name.' },
		what: { type: 'string', description: 'The change, in one or two sentences.' },
		why: { type: 'string', description: 'Why the task needs it.' },
	},
} as const;

/** What the agent gives `propose`. */
export interface ProposeParams {
	kind: ProposeKind;
	target: string;
	what: string;
	why: string;
}

export interface FillHost {
	channel: Channel;
	/** This session's id. */
	id: string;
	/** True when the editor follows this session. */
	owner(): boolean;
	scope(): Scope;
	/** Puts the fill in the session record (null: none) and beats. */
	publish(fill: Session['fill']): void;
	/** Sends the agent a user message, now or after its run. */
	send(text: string): void;
}

function readText(path: string): string | null {
	return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

export class Filling {
	fill: Fill | undefined;
	private lastRequest: string | undefined;
	/** Counts the editor's requests: a start that a newer request overtook is dropped. */
	private requests = 0;
	/** The guard's results of the calls that may run, by call id: committed when a call ran. */
	private readonly pending = new Map<string, { fill: Fill; result: GuardResult }>();
	/** The stub's file before each other tool (bash, ...) ran, by call id: put back if it changed. */
	private readonly kept = new Map<string, string>();
	private readonly host: FillHost;

	constructor(host: FillHost) {
		this.host = host;
	}

	/** At the start of a session: a request from before it is old. */
	skipOld(): void {
		this.lastRequest = this.host.channel.enabled() ? this.host.channel.fill()?.id : undefined;
	}

	/** fill! in the editor: a new fill for this session, or its release. */
	async poll(cwd: string): Promise<void> {
		const { channel, id } = this.host;
		if (!channel.enabled()) return;
		const request = channel.fill();
		if (!request || request.to !== id || request.id === this.lastRequest) return;
		this.lastRequest = request.id;
		const generation = ++this.requests;
		if (request.release) {
			if (this.fill) this.notice(`symbiosis: released ${targetText(this.fill.target)}`, 'info');
			this.end();
			return;
		}
		const path = realPath(request.path);
		const started = await Fill.start({ mode: request.mode, path, line: request.line, shown: relative(cwd, path) || path, root: cwd, read: readText }).catch(
			(error: unknown) => ({ error: `could not read ${relative(cwd, path) || path}: ${error instanceof Error ? error.message : String(error)}` }),
		);
		if (generation !== this.requests) return;
		if ('error' in started) {
			this.notice(`symbiosis: ${started.error}`, 'warn');
			return;
		}
		this.fill = started.fill;
		this.pending.clear();
		this.publish();
		this.host.send(started.message);
	}

	/**
	 * Before a write or edit runs: blocks it when it reaches past the target. The
	 * reason goes to the agent; the editor drops what it showed of the call.
	 * A call that may run spends nothing yet: see `ran`.
	 */
	async check(call: string, tool: 'write' | 'edit', input: unknown, cwd: string): Promise<{ block: true; reason: string } | undefined> {
		const fill = this.fill;
		if (!fill) return undefined;
		const change = await planned(tool, input, cwd);
		if (!change) return undefined;
		const result = await fill.check(change.path, readText(change.path), change.text, this.host.scope());
		if (!result.ok) return { block: true, reason: result.reason };
		this.pending.set(call, { fill, result });
		return undefined;
	}

	/**
	 * A checked call ended. When it ran, its allowances are spent and the
	 * target moves with it; a call stopped before it ran (the editor, another
	 * handler) or failed changes nothing.
	 */
	ran(call: string, ok: boolean): void {
		const entry = this.pending.get(call);
		this.pending.delete(call);
		if (!entry || !ok || entry.fill !== this.fill) return;
		entry.fill.commit(entry.result);
		// A tool that runs at the same time keeps the file as this call left it.
		const text = readText(entry.fill.target.path);
		if (text !== null) for (const id of this.kept.keys()) this.kept.set(id, text);
		this.publish();
	}

	/**
	 * Before a tool other than write and edit (bash, another extension's
	 * tool): keeps the target's file, to put it back if the tool changes it.
	 */
	keep(call: string): void {
		const text = this.fill ? readText(this.fill.target.path) : null;
		if (text !== null) this.kept.set(call, text);
	}

	/**
	 * After that tool: when it changed the target's file, the file is put back
	 * and the agent is told why. Changes to other files are not seen (see
	 * docs/design.md, the weak points).
	 */
	restore(call: string, cwd: string): string | undefined {
		const before = this.kept.get(call);
		this.kept.delete(call);
		const target = this.fill?.target;
		if (!target || before === undefined || readText(target.path) === before) return undefined;
		writeFileSync(target.path, before);
		return [
			`symbiosis undid this call's change to ${relative(cwd, target.path) || target.path}: you are filling ${targetText(target)} there.`,
			'Change that file only with edit or write (the guard checks them), or call propose.',
			stayInside(target),
		].join(' ');
	}

	/**
	 * At the end of a run: finished work ends the fill and is returned, for the
	 * developer's review. A fill that waits on the developer stays.
	 */
	async settle(): Promise<Landing | undefined> {
		this.pending.clear();
		this.kept.clear();
		// A file that cannot be read now keeps the fill: the developer can release it.
		const landing = await this.fill?.landing().catch(() => undefined);
		if (landing) this.end();
		return landing;
	}

	end(): void {
		this.pending.clear();
		this.kept.clear();
		if (!this.fill) return;
		this.fill = undefined;
		this.host.publish(null);
	}

	/** The `propose` tool's work: asks the editor and waits for the answer. */
	async propose(call: string, params: ProposeParams, cwd: string, signal?: AbortSignal): Promise<string> {
		const fill = this.fill;
		if (!fill) return 'Nothing is being filled: nothing to propose. Go on with the task.';
		if (!PROPOSE_KINDS.includes(params.kind)) return `Unknown kind "${params.kind}": use one of ${PROPOSE_KINDS.join(', ')}.`;
		if (!this.host.owner()) return 'Rejected: no one to ask (the editor does not follow this session). Stay inside what you fill.';
		const target = params.kind === 'new_file' || params.kind === 'outside_edit' ? namedPath(params.target, cwd) : params.target.trim();
		const proposal = { id: call, session: this.host.id, kind: params.kind, target, what: params.what, why: params.why };
		this.emit({ op: 'propose', ...proposal });
		const answer = await this.waitAnswer(call, signal);
		// Also when the editor stopped following: it may still show the question.
		if (this.host.channel.enabled()) this.host.channel.emit({ op: 'propose_end', id: call });
		if (!answer) return signal?.aborted ? 'Stopped before the developer answered.' : 'Rejected: the editor stopped following this session.';
		const note = answer.note ? ` Note from the developer: "${answer.note}".` : '';
		if (!answer.accept) return `Rejected.${note} ${stayInside(fill.target)} Or propose something else.`;
		fill.allow(params.kind, target);
		return `Accepted: ${params.kind} \`${target}\`, once.${note} Make the whole change in one call.`;
	}

	/**
	 * The editor's answer to `call`; undefined when the turn stops, or the
	 * editor stops following this session for LOST_MS (one bad read of
	 * ttt.json, while ttt writes it, is not enough).
	 */
	private async waitAnswer(call: string, signal?: AbortSignal): Promise<ProposalAnswer | undefined> {
		let lostAt: number | undefined;
		while (!signal?.aborted) {
			const answer = this.host.channel.answer();
			if (answer?.id === call) return answer;
			if (this.host.owner()) lostAt = undefined;
			else if (lostAt === undefined) lostAt = Date.now();
			else if (Date.now() - lostAt > LOST_MS) return undefined;
			await new Promise((r) => setTimeout(r, ANSWER_MS));
		}
		return undefined;
	}

	private publish(): void {
		const target = this.fill?.target;
		this.host.publish(target ? { kind: target.kind, path: target.path, name: targetName(target), line: target.line } : null);
	}

	private notice(text: string, level: 'info' | 'warn'): void {
		this.emit({ op: 'notice', text, level });
	}

	private emit(event: ChannelEvent): void {
		if (this.host.owner()) this.host.channel.emit(event);
	}
}
