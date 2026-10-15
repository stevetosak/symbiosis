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

	/**
	 * A fill of the stub that holds `line` of `path`. `shown` is the path as
	 * the agent should see it in the message (relative to its folder).
	 */
	static async start(path: string, line: number, shown: string, root: string, read: ReadText): Promise<{ fill: Fill; message: string } | { error: string }> {
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
	 * `after`. When it is ok, the allowances it uses are spent and the stub is
	 * found again in the new text.
	 */
	async check(path: string, before: string | null, after: string, scope: Scope): Promise<GuardResult> {
		const own = path === this.stub.path;
		const syntax = own ? await syntaxFor(path) : undefined;
		const version = (text: string): Version => ({ text, outline: syntax ? syntax.outline(text) : null });
		const result = guard({
			scope,
			stub: this.stub,
			path,
			before: before === null ? null : version(before),
			after: version(after),
			resolves: resolverFor(syntax?.language.id ?? '', fsProject(this.root)),
			allowances: this.allowances,
		});
		if (result.ok) {
			for (const used of result.used) this.allowances.splice(this.allowances.indexOf(used), 1);
			if (result.stub) this.stub = result.stub;
		}
		return result;
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
