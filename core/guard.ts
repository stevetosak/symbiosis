// The scope guard: while a stub is being filled, every edit and write is
// checked before it runs. Pure: the caller parses both versions of the file
// (core/syntax) and loads the import resolver (core/imports); the guard only
// compares.
//
// The check, on the stub's file: mask the stub's body (and its signature, if
// a change to it was accepted) in both versions, cut the import lines and the
// declarations that are new, and compare what is left with its whitespace
// collapsed. Any difference is an edit outside the body. New imports and new
// declarations are judged on their own. Any other file is outside the stub.
import type { Resolver } from './imports/policy.ts';
import { locate, normalize, type StubRef, stubRef } from './stubs.ts';
import { contains, type Decl, type Fn, type Outline, type Range } from './syntax/outline.ts';

/** `stub`: only the body. `file`: also new private declarations in its file. `off`: no guard. */
export type Scope = 'stub' | 'file' | 'off';
export const SCOPES: readonly Scope[] = ['stub', 'file', 'off'];

/** What the agent may `propose`; each is also the kind of a violation. */
export type ProposeKind = 'new_file' | 'new_decl' | 'signature' | 'dependency' | 'outside_edit';
export const PROPOSE_KINDS: readonly ProposeKind[] = ['new_file', 'new_decl', 'signature', 'dependency', 'outside_edit'];

/**
 * An accepted proposal not used yet: it lets one violation of its kind and
 * target through, once. The target is what the violation names: the path
 * (`new_file`, `outside_edit`), the import (`dependency`), the declaration's
 * name (`new_decl`), the stub's name (`signature`).
 */
export interface Allowance {
	kind: ProposeKind;
	target: string;
}

/** True when an allowance's target is the violation's. */
export function sameTarget(a: string, b: string): boolean {
	return a.trim() === b.trim();
}

/** A file's text and its outline; the outline is null for a language symbiosis does not parse. */
export interface Version {
	text: string;
	outline: Outline | null;
}

export interface GuardInput {
	scope: Scope;
	/** The stub being filled; null when none is. */
	stub: StubRef | null;
	/** Absolute path of the file the call changes. */
	path: string;
	/** The file now; null when it does not exist. */
	before: Version | null;
	/** The file after the call. */
	after: Version;
	/** Resolves a new import of the stub's language. */
	resolves: Resolver;
	/** Accepted proposals not used yet. */
	allowances: readonly Allowance[];
}

export interface Violation {
	kind: ProposeKind;
	/** What an allowance must name to let it through (see Allowance). */
	target: string;
	detail: string;
}

export interface GuardResult {
	ok: boolean;
	/** What stops the call; empty when ok. */
	violations: Violation[];
	/** The allowances this call spends, when it is ok. */
	used: Allowance[];
	/** The stub as found after the call: its signature or line may have moved. */
	stub: StubRef | null;
	/** For the model when the call is blocked; "" when ok. */
	reason: string;
}

const STUB_MASK = '\u0000';

export function guard(input: GuardInput): GuardResult {
	const { scope, stub } = input;
	if (scope === 'off' || !stub) return { ok: true, violations: [], used: [], stub, reason: '' };
	if (input.path !== stub.path) {
		const detail = input.before ? `the call edits ${input.path}, not the stub's file` : `the call creates ${input.path}`;
		return settle(input, [{ kind: input.before ? 'outside_edit' : 'new_file', target: input.path, detail }], stub);
	}
	const { before, after } = input;
	if (!before?.outline || !after.outline) {
		return settle(input, [{ kind: 'outside_edit', target: stub.path, detail: `${stub.path} could not be read as code` }], stub);
	}
	return checkStubFile(input, stub, { text: before.text, outline: before.outline }, { text: after.text, outline: after.outline });
}

interface Parsed {
	text: string;
	outline: Outline;
}

function checkStubFile(input: GuardInput, stub: StubRef, before: Parsed, after: Parsed): GuardResult {
	const violations: Violation[] = [];
	const oldFn = locate(before.outline, before.text, stub) ?? locate(before.outline, before.text, stub, true);
	if (!oldFn) return settle(input, [{ kind: 'outside_edit', target: stub.path, detail: `the stub \`${stub.name}\` is no longer in the file` }], stub);

	let newFn = locate(after.outline, after.text, stub);
	let signatureChanged = false;
	if (!newFn) {
		newFn = locate(after.outline, after.text, stub, true);
		if (!newFn) return settle(input, [{ kind: 'signature', target: stub.name, detail: `the call removes or renames \`${stub.name}\`` }], stub);
		signatureChanged = true;
		const now = normalize(after.text.slice(newFn.signature.start, newFn.signature.end));
		violations.push({ kind: 'signature', target: stub.name, detail: `the signature changes from \`${stub.signature}\` to \`${now}\`` });
	}

	const imports = compareImports(stub.path, input.resolves, { ...before, fn: oldFn }, { ...after, fn: newFn });
	violations.push(...imports.violations);
	const decls = newDecls(before, after, imports.added);
	const oldNames = new Set(before.outline.decls.map((d) => d.name));
	for (const decl of decls) {
		const shadows = oldNames.has(decl.name);
		if (input.scope === 'file' && decl.private && !shadows) continue;
		const what = shadows ? 'a second declaration of' : decl.private ? 'a new private declaration' : 'a new declaration';
		violations.push({ kind: 'new_decl', target: decl.name || decl.kind, detail: `${what} \`${decl.name || decl.kind}\` outside the body` });
	}

	const masked = (fn: Fn) => (signatureChanged ? { start: fn.signature.start, end: fn.body.end } : fn.body);
	const oldSkeleton = skeleton(before.text, masked(oldFn), imports.removed);
	const newSkeleton = skeleton(after.text, masked(newFn), [...imports.added, ...decls.map((d) => declCut(d, before.text, after.text))]);
	if (oldSkeleton === null || newSkeleton === null) {
		violations.push({ kind: 'outside_edit', target: stub.path, detail: `the call changes the code that holds \`${stub.name}\`` });
	} else if (oldSkeleton !== newSkeleton) {
		violations.push({ kind: 'outside_edit', target: stub.path, detail: `the call changes code outside the body, near: ${near(oldSkeleton, newSkeleton)}` });
	}

	return settle(input, violations, stubRef(stub.path, after.text, newFn));
}

/** One import statement: its range, its text with whitespace collapsed, what it imports. */
interface Statement {
	range: Range;
	key: string;
	specs: string[];
}

function statements(version: Parsed): Statement[] {
	const byStart = new Map<number, Statement>();
	for (const { spec, range } of version.outline.imports) {
		const known = byStart.get(range.start);
		if (known) known.specs.push(spec);
		else byStart.set(range.start, { range, key: normalize(version.text.slice(range.start, range.end)), specs: [spec] });
	}
	return [...byStart.values()];
}

/** The statements of `after` whose text is not in `before`, each old one used once; and the old ones left over. */
function unmatched(before: Statement[], after: Statement[]): { added: Statement[]; removed: Statement[] } {
	const removed = [...before];
	const added = after.filter((s) => {
		const at = removed.findIndex((o) => o.key === s.key);
		if (at >= 0) removed.splice(at, 1);
		return at < 0;
	});
	return { added, removed };
}

/**
 * The import lines outside function bodies must stay as they are: one that
 * changes could rebind a name the rest of the file uses (`{ helper }` →
 * `{ evil as helper }`), so it counts as removed and added. A new one must
 * resolve. In the stub's body a new import must resolve too; imports in other
 * bodies are code like any other.
 */
function compareImports(path: string, resolves: Resolver, before: Parsed & { fn: Fn }, after: Parsed & { fn: Fn }) {
	const inBody = (all: Statement[], fn: Fn) => all.filter((s) => contains(fn.body, s.range));
	const outside = (all: Statement[], outline: Outline) => all.filter((s) => !outline.functions.some((f) => contains(f.body, s.range)));
	const old = statements(before);
	const now = statements(after);
	const top = unmatched(outside(old, before.outline), outside(now, after.outline));
	const body = unmatched(inBody(old, before.fn), inBody(now, after.fn));

	const violations: Violation[] = [];
	for (const spec of [...top.added, ...body.added].flatMap((s) => s.specs)) {
		if (!resolves(spec, after.text)) {
			violations.push({ kind: 'dependency', target: spec, detail: `the import \`${spec}\` is not in the project, the standard library or the manifest` });
		}
	}
	for (const s of top.removed) {
		violations.push({ kind: 'outside_edit', target: path, detail: `the call changes or removes the import \`${s.key}\` (add a new import line instead of changing one)` });
	}
	return { violations, added: top.added.map((s) => s.range), removed: top.removed.map((s) => s.range) };
}

/**
 * The declarations in `after` that were not in `before`. Two with the same
 * kind and name are the same one, so only a kind and name that is there more
 * often than before has new ones. Those whose text is in `before` are old; of
 * the rest, the last ones count as new (an edited old one and a new one look
 * alike, so the detail may name the wrong one, never too few). Declarations
 * inside a new import line, or inside another new declaration, do not count.
 */
function newDecls(before: Parsed, after: Parsed, imports: Range[]): Decl[] {
	const key = (d: Decl) => `${d.kind}\u0000${d.name}`;
	const textOf = (text: string, d: Decl) => normalize(text.slice(d.range.start, d.range.end));
	const old = Map.groupBy(before.outline.decls, key);
	const found: Decl[] = [];
	const fresh = after.outline.decls.filter((d) => !imports.some((r) => contains(r, d.range)));
	for (const [k, decls] of Map.groupBy(fresh, key)) {
		const left = (old.get(k) ?? []).map((d) => textOf(before.text, d));
		const surplus = decls.length - left.length;
		if (surplus <= 0) continue;
		const unknown = decls.filter((d) => {
			const at = left.indexOf(textOf(after.text, d));
			if (at >= 0) left.splice(at, 1);
			return at < 0;
		});
		found.push(...unknown.slice(unknown.length - surplus));
	}
	return found.filter((d) => !found.some((o) => o !== d && contains(o.range, d.range)));
}

/** A new declaration with its doc comment, unless that comment was there before (a section heading above it). */
function declCut(decl: Decl, beforeText: string, afterText: string): Range {
	if (!decl.doc || beforeText.includes(afterText.slice(decl.doc.start, decl.doc.end))) return decl.range;
	return { start: decl.doc.start, end: decl.range.end };
}

/**
 * The text with `stub` as one mark and `cut` removed, whitespace collapsed;
 * null when a cut swallows the stub. Ranges are sorted by start; one that
 * starts inside the last is merged into it.
 */
function skeleton(text: string, stub: Range, cut: Range[]): string | null {
	const ranges = [{ ...stub, mark: STUB_MASK }, ...cut.map((r) => ({ ...r, mark: ' ' }))].sort((a, b) => a.start - b.start);
	let out = '';
	let at = 0;
	for (const r of ranges) {
		if (r.end <= at) continue;
		out += text.slice(at, Math.max(at, r.start)) + r.mark;
		at = r.end;
	}
	const result = normalize(out + text.slice(at));
	return result.includes(STUB_MASK) ? result : null;
}

/** Some text of `after` where it first differs from `before`. */
function near(before: string, after: string): string {
	let i = 0;
	while (i < before.length && before[i] === after[i]) i++;
	const at = Math.max(0, i - 20);
	return JSON.stringify(after.slice(at, at + 60).replaceAll(STUB_MASK, '<body>'));
}

/** Spends the allowances on the violations they cover; what is left blocks the call. */
function settle(input: GuardInput, violations: Violation[], found: StubRef): GuardResult {
	const left = [...input.allowances];
	const used: Allowance[] = [];
	const blocking = violations.filter((v) => {
		const at = left.findIndex((a) => a.kind === v.kind && sameTarget(a.target, v.target));
		if (at < 0) return true;
		used.push(...left.splice(at, 1));
		return false;
	});
	if (blocking.length === 0) return { ok: true, violations: [], used, stub: found, reason: '' };
	const stub = input.stub as StubRef;
	return { ok: false, violations: blocking, used: [], stub, reason: reasonFor(input, stub, blocking) };
}

function reasonFor(input: GuardInput, stub: StubRef, violations: Violation[]): string {
	const proposals = [...new Set(violations.map((v) => `kind "${v.kind}", target "${v.target}"`))];
	return [
		`Blocked by symbiosis: you are filling the stub \`${stub.name}\` in ${stub.path} (scope: ${input.scope}).`,
		...violations.map((v) => `- ${v.kind} (target \`${v.target}\`): ${v.detail}.`),
		...(input.after.outline?.broken ? ['- The file does not parse after this call: check the edit for an unclosed string, bracket or block.'] : []),
		`Edit only inside the body of \`${stub.name}\`. If the task needs this change, call propose with ${proposals.join('; and with ')}, say what and why, and wait for the answer.`,
		'An accepted proposal lets exactly that one change through, once: make the whole change in one call.',
	].join('\n');
}
