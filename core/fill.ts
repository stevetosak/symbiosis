// One stub being filled: the guard's state between the agent's calls. The
// developer starts a fill (fill! or the palette); each write and edit of the
// agent is checked against it (core/guard.ts); an accepted proposal adds an
// allowance; the fill ends when the body is no longer a stub, or when the
// developer releases it. No agent and no editor here: an adapter (pi/) feeds
// it the files before and after each call.
import { type Allowance, guard, type GuardResult, type ProposeKind, type Scope, type Version } from './guard.ts';
import { resolverFor } from './imports/index.ts';
import { fsProject } from './imports/project.ts';
import { fillMessage, locate, type StubRef, stubAt, stubRef } from './stubs.ts';
import { syntaxFor } from './syntax/parse.ts';

/** Reads a file's text; null when it does not exist. */
export type ReadText = (path: string) => string | null;

export interface FillStart {
	path: string;
	line: number;
	/** The path as the agent should see it in the message (relative to its folder). */
	shown: string;
	/** The project's folder: where imports resolve. */
	root: string;
	read: ReadText;
}

export class Fill {
	stub: StubRef;
	/** Accepted proposals not used yet. */
	allowances: Allowance[] = [];
	private readonly root: string;
	private readonly read: ReadText;

	private constructor(stub: StubRef, root: string, read: ReadText) {
		this.stub = stub;
		this.root = root;
		this.read = read;
	}

	/** A fill of the stub that holds `line` of `path`. */
	static async start({ path, line, shown, root, read }: FillStart): Promise<{ fill: Fill; message: string } | { error: string }> {
		const syntax = await syntaxFor(path);
		if (!syntax) return { error: `symbiosis does not parse ${shown}` };
		const text = read(path);
		if (text === null) return { error: `${shown} does not exist` };
		const fn = stubAt(syntax.outline(text), line);
		if (!fn) return { error: `no stub at line ${line} of ${shown}: a stub's body holds only a TODO(pi) comment and placeholders` };
		return { fill: new Fill(stubRef(path, text, fn), root, read), message: fillMessage(shown, text, fn) };
	}

	/** An accepted proposal: lets one violation of this kind and target through. */
	allow(kind: ProposeKind, target: string): void {
		this.allowances.push({ kind, target });
	}

	/**
	 * Checks one call that changes `path` from `before` (null: a new file) to
	 * `after`. Changes nothing: `commit` the result once the call has run.
	 */
	async check(path: string, before: string | null, after: string, scope: Scope): Promise<GuardResult> {
		const own = path === this.stub.path;
		const syntax = own ? await syntaxFor(path) : undefined;
		const version = (text: string): Version => ({ text, outline: syntax ? syntax.outline(text) : null });
		return guard({
			scope,
			stub: this.stub,
			path,
			before: before === null ? null : version(before),
			after: version(after),
			resolves: resolverFor(syntax?.language.id ?? '', fsProject(this.root)),
			allowances: this.allowances,
		});
	}

	/** A checked call ran: its allowances are spent and the stub is where it left it. */
	commit(result: GuardResult): void {
		if (!result.ok) return;
		this.allowances = this.allowances.filter((a) => !result.used.includes(a));
		if (result.stub) this.stub = result.stub;
	}

	/** True when the stub's body is filled: the function is there and no longer a stub. */
	async filled(): Promise<boolean> {
		const syntax = await syntaxFor(this.stub.path);
		const text = this.read(this.stub.path);
		if (!syntax || text === null) return false;
		const outline = syntax.outline(text);
		const fn = locate(outline, text, this.stub) ?? locate(outline, text, this.stub, true);
		return fn !== undefined && !fn.stub;
	}
}
