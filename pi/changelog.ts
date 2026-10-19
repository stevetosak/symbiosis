// Every write and edit pi made, in the order it made them, each with the plan
// step it belonged to, for the change list in ttt. Unlike pi/changes.ts (the
// diff key: the last turn only) it keeps them across turns, until the plugin
// is told they are seen (a later slice) or the log is full.
//
//   log/<session>/index.json   {session, changes: LoggedChange[]}, oldest first
//   log/<session>/<id>.json    {before: string | null, after: string}
//
// The plugin reads only these files: ttt.fs cannot read outside the workspace.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hunksOf } from '../core/hunks.ts';
import type { LoggedChange, Step } from '../core/protocol.ts';
import { readText } from './changes.ts';

/** The log keeps this many changes; the oldest go first. */
export const MAX_CHANGES = 300;
/** A text over this is not kept: the change has its hunks, no diff. */
const MAX_TEXT = 256 * 1024;
/** A session's log older than this is removed when a new one starts. */
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function write(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

/** The step a change belongs to: the one pi works on, else the last done one, else none. */
export function stepOf(plan: Step[]): { step: number; text: string } | undefined {
	let at = plan.findIndex((s) => s.state === 'now');
	if (at < 0) at = plan.map((s) => s.state).lastIndexOf('done');
	return at < 0 ? undefined : { step: at, text: plan[at].text };
}

export class ChangeLog {
	readonly dir: string;
	readonly session: string;
	readonly now: () => number;
	changes: LoggedChange[] = [];
	private seq = 0;
	/** call id -> the file's text before the call. */
	private readonly pending = new Map<string, string | null>();

	constructor(root: string, session: string, now: () => number = Date.now) {
		this.dir = join(root, session);
		this.session = session;
		this.now = now;
		this.clean(root);
	}

	/** Other sessions' logs that nobody reads any more. */
	private clean(root: string): void {
		try {
			for (const name of readdirSync(root)) {
				if (name === this.session) continue;
				const dir = join(root, name);
				if (this.now() - statSync(dir).mtimeMs > MAX_AGE_MS) rmSync(dir, { recursive: true, force: true });
			}
		} catch {
			// no log folder yet
		}
	}

	/** Just before the call runs: the file as it is. */
	before(call: string, path: string): void {
		this.pending.set(call, readText(path));
	}

	/** After a call that ran: what it changed. A call that changed nothing is not logged. */
	after(call: string, tool: 'write' | 'edit', path: string, plan: Step[], why?: string): LoggedChange | undefined {
		if (!this.pending.has(call)) return undefined;
		const before = this.pending.get(call) ?? null;
		this.pending.delete(call);
		const after = readText(path);
		if (after === null || after === before) return undefined;
		const hunks = hunksOf(before, after);
		if (hunks.length === 0) return undefined;
		const step = stepOf(plan);
		const texts = (before ?? '').length <= MAX_TEXT && after.length <= MAX_TEXT;
		const change: LoggedChange = {
			id: `${++this.seq}`,
			seq: this.seq,
			t: this.now() / 1000,
			call,
			tool,
			path,
			step: step?.step ?? null,
			stepText: step?.text ?? null,
			created: before === null,
			hunks,
			texts,
			...(why ? { why } : {}),
		};
		mkdirSync(this.dir, { recursive: true });
		if (texts) write(join(this.dir, `${change.id}.json`), JSON.stringify({ before, after }));
		this.changes.push(change);
		while (this.changes.length > MAX_CHANGES) {
			const old = this.changes.shift();
			if (old) rmSync(join(this.dir, `${old.id}.json`), { force: true });
		}
		write(join(this.dir, 'index.json'), JSON.stringify({ session: this.session, changes: this.changes }));
		return change;
	}

	/** A call that did not run: forget its text. */
	drop(call: string): void {
		this.pending.delete(call);
	}

	/** The texts of one change, for tests and the plugin's diff. */
	texts(id: string): { before: string | null; after: string } | undefined {
		try {
			return JSON.parse(readFileSync(join(this.dir, `${id}.json`), 'utf-8'));
		} catch {
			return undefined;
		}
	}
}
