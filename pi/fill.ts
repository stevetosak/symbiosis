// Stub filling, the pi side: fill! in the editor starts a fill (core/fill.ts),
// each write and edit of the agent is checked by the guard before it runs,
// and the `propose` tool asks the developer, in the editor, for a change the
// guard blocks. The fill ends at the end of a run once the body is no longer a
// stub, or when the developer releases it.
import { existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Channel } from '../core/channel/channel.ts';
import { Fill } from '../core/fill.ts';
import { PROPOSE_KINDS, type ProposeKind, type Scope } from '../core/guard.ts';
import type { ChannelEvent, ProposalAnswer, Session } from '../core/protocol.ts';
import { absolutePath } from '../core/stream.ts';
import { editResult, pathOf } from './tools.ts';

/** How often propose reads the editor's answer. */
const ANSWER_MS = 100;
/** How long the editor may not follow this session before propose gives up. */
const LOST_MS = 1500;

export const PROPOSE_DESCRIPTION =
	'Ask the developer for a change the symbiosis guard blocks while you fill a stub: a new file, a new declaration, a signature change, a new dependency, or an edit outside the stub. Waits for the answer. An accepted proposal lets exactly that one change through, once.';

export const PROPOSE_PARAMETERS = {
	type: 'object',
	required: ['kind', 'target', 'what', 'why'],
	properties: {
		kind: { type: 'string', enum: [...PROPOSE_KINDS], description: 'The kind the guard named.' },
		target: { type: 'string', description: 'The target the guard named: a path, an import, a declaration name, or the stub name.' },
		what: { type: 'string', description: 'The change, in one or two sentences.' },
		why: { type: 'string', description: 'Why the stub needs it.' },
	},
} as const;

export interface FillHost {
	channel: Channel;
	/** This session's id. */
	id: string;
	/** True when the editor follows this session. */
	owner(): boolean;
	scope(): Scope;
	/** Puts the stub in the session record (null: no fill) and beats. */
	publish(stub: Session['stub']): void;
	/** Sends the agent a user message, now or after its run. */
	send(text: string): void;
}

function readText(path: string): string | null {
	return existsSync(path) ? readFileSync(path, 'utf-8') : null;
}

export class Filling {
	fill: Fill | undefined;
	private lastRequest: string | undefined;
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
		if (request.release) {
			if (this.fill) this.notice(`symbiosis: released the stub ${this.fill.stub.name}`, 'info');
			this.end();
			return;
		}
		const started = await Fill.start(request.path, request.line, relative(cwd, request.path) || request.path, cwd, readText);
		if ('error' in started) {
			this.notice(`symbiosis: ${started.error}`, 'warn');
			return;
		}
		this.fill = started.fill;
		this.publish();
		this.host.send(started.message);
	}

	/**
	 * Before a write or edit runs: blocks it when it reaches past the stub. The
	 * reason goes to the agent; the editor drops what it showed of the call.
	 */
	async check(tool: 'write' | 'edit', input: unknown, cwd: string): Promise<{ block: true; reason: string } | undefined> {
		const fill = this.fill;
		const path = pathOf(input, cwd);
		if (!fill || !path) return undefined;
		const before = readText(path);
		const after = tool === 'write' ? (input as { content?: unknown }).content : await editResult(input, cwd);
		if (typeof after !== 'string') return undefined;
		const result = await fill.check(path, before, after, this.host.scope());
		if (result.ok) {
			this.publish();
			return undefined;
		}
		return { block: true, reason: result.reason };
	}

	/** At the end of a run: a filled stub ends the fill. A fill that waits on the developer stays. */
	async settle(): Promise<void> {
		if (this.fill && (await this.fill.filled())) this.end();
	}

	end(): void {
		if (!this.fill) return;
		this.fill = undefined;
		this.host.publish(null);
	}

	/** The `propose` tool's work: asks the editor and waits for the answer. */
	async propose(call: string, params: { kind: ProposeKind; target: string; what: string; why: string }, cwd: string, signal?: AbortSignal): Promise<string> {
		const fill = this.fill;
		if (!fill) return 'No stub is being filled: nothing to propose. Go on with the task.';
		if (!PROPOSE_KINDS.includes(params.kind)) return `Unknown kind "${params.kind}": use one of ${PROPOSE_KINDS.join(', ')}.`;
		if (!this.host.owner()) return 'Rejected: no one to ask (the editor does not follow this session). Stay inside the body.';
		const target = params.kind === 'new_file' || params.kind === 'outside_edit' ? absolutePath(params.target, cwd) : params.target.trim();
		const proposal = { id: call, session: this.host.id, kind: params.kind, target, what: params.what, why: params.why };
		this.emit({ op: 'propose', ...proposal });
		const answer = await this.waitAnswer(call, signal);
		this.emit({ op: 'propose_end', id: call });
		if (!answer) return signal?.aborted ? 'Stopped before the developer answered.' : 'Rejected: the editor stopped following this session.';
		const note = answer.note ? ` Note from the developer: "${answer.note}".` : '';
		if (!answer.accept) return `Rejected.${note} Stay inside the body of \`${fill.stub.name}\`, or propose something else.`;
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
		const stub = this.fill?.stub;
		this.host.publish(stub ? { path: stub.path, name: stub.name, line: stub.line } : null);
	}

	private notice(text: string, level: 'info' | 'warn'): void {
		this.emit({ op: 'notice', text, level });
	}

	private emit(event: ChannelEvent): void {
		if (this.host.owner()) this.host.channel.emit(event);
	}
}
