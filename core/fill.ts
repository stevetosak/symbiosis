// One fill: a stub's body, or a new function under its description. The
// guard's state between the agent's calls. The developer starts a fill
// (helpi! or the palette); each write and edit of the agent is checked
// against it (core/guard.ts); an accepted proposal adds an allowance; the
// fill ends when the body is no longer a stub (or the new function is there
// and is no stub), or when the developer releases it. No agent and no editor
// here: an adapter (pi/) feeds it the files before and after each call.
import { type Allowance, guard, type GuardResult, type ProposeKind, type Scope, type Version } from './guard.ts';
import { resolverFor } from './imports/index.ts';
import { fsProject } from './imports/project.ts';
import { describeAt, findPlace, inBody, type PlaceRef, placeMessage } from './place.ts';
import type { FillMode } from './protocol.ts';
import { fillMessage, locate, stubAt, stubRef } from './stubs.ts';
import { contains, type Outline } from './syntax/outline.ts';
import { syntaxFor } from './syntax/parse.ts';
import type { FillTarget } from './target.ts';

/** Reads a file's text; null when it does not exist. */
export type ReadText = (path: string) => string | null;

export interface FillStart {
	/** `stub`: the stub that holds `line`. `function`: a new function under the description that ends at `line`. */
	mode: FillMode;
	path: string;
	line: number;
	/** The path as the agent should see it in the message (relative to its folder). */
	shown: string;
	/** The project's folder: where imports resolve. */
	root: string;
	read: ReadText;
}

type Started = { fill: Fill; message: string } | { error: string };

export class Fill {
	target: FillTarget;
	/** Accepted proposals not used yet. */
	allowances: Allowance[] = [];
	private readonly root: string;
	private readonly read: ReadText;

	private constructor(target: FillTarget, root: string, read: ReadText) {
		this.target = target;
		this.root = root;
		this.read = read;
	}

	static async start(start: FillStart): Promise<Started> {
		const { path, shown, read } = start;
		const syntax = await syntaxFor(path);
		if (!syntax) return { error: `symbiosis does not parse ${shown}` };
		const text = read(path);
		if (text === null) return { error: `${shown} does not exist` };
		const outline = syntax.outline(text);
		return start.mode === 'function' ? Fill.startPlace(start, text, outline) : Fill.startStub(start, text, outline);
	}

	/** A fill of the stub that holds `line`. */
	private static startStub({ path, line, shown, root, read }: FillStart, text: string, outline: Outline): Started {
		const fn = stubAt(outline, line);
		if (!fn) return { error: `no stub at line ${line} of ${shown}: a stub's body holds only a TODO(pi) comment and placeholders` };
		return { fill: new Fill(stubRef(path, text, fn), root, read), message: fillMessage(shown, text, fn) };
	}

	/** A new function under the description that ends at `line`. */
	private static startPlace({ path, line, shown, root, read }: FillStart, text: string, outline: Outline): Started {
		const described = describeAt(text, line);
		if (!described) return { error: `no comment at line ${line} of ${shown} to write a function under` };
		const place: PlaceRef = { kind: 'place', path, description: described.description, line: described.line, name: '' };
		const found = findPlace(outline, text, place);
		if (!found) return { error: `the description at line ${line} of ${shown} could not be found again` };
		if (found.decl) return { error: `the comment at line ${line} of ${shown} is the comment of \`${found.decl.name}\`: leave a blank line under it` };
		if (inBody(outline, found.description.start)) {
			return { error: `the comment at line ${line} of ${shown} is inside a function: a new function goes outside other bodies` };
		}
		return { fill: new Fill(place, root, read), message: placeMessage(shown, place) };
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
		const own = path === this.target.path;
		const syntax = own ? await syntaxFor(path) : undefined;
		const version = (text: string): Version => ({ text, outline: syntax ? syntax.outline(text) : null });
		return guard({
			scope,
			target: this.target,
			path,
			before: before === null ? null : version(before),
			after: version(after),
			resolves: resolverFor(syntax?.language.id ?? '', fsProject(this.root)),
			allowances: this.allowances,
		});
	}

	/** A checked call ran: its allowances are spent and the target is where it left it. */
	commit(result: GuardResult): void {
		if (!result.ok) return;
		this.allowances = this.allowances.filter((a) => !result.used.includes(a));
		if (result.target) this.target = result.target;
	}

	/**
	 * True when the work is done: the stub's function is there and no longer
	 * a stub; or the new function is there and no function in it is a stub.
	 */
	async filled(): Promise<boolean> {
		const target = this.target;
		const syntax = await syntaxFor(target.path);
		const text = this.read(target.path);
		if (!syntax || text === null) return false;
		const outline = syntax.outline(text);
		if (target.kind === 'place') {
			const decl = findPlace(outline, text, target)?.decl;
			return decl !== undefined && !outline.functions.some((f) => f.stub && contains(decl.range, f.range));
		}
		const fn = locate(outline, text, target) ?? locate(outline, text, target, true);
		return fn !== undefined && !fn.stub;
	}
}
