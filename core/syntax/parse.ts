// tree-sitter, through its WASM build: one runtime, a grammar per language,
// each loaded on the first file of its language and kept (C# takes a third of
// a second, measured). The tree is turned into an Outline and freed at once.
import { createRequire } from 'node:module';
import { Language, type Node, Parser } from 'web-tree-sitter';
import type { LanguageSpec } from './language.ts';
import { languageOf } from './languages/index.ts';
import { contains, type Decl, type Fn, type Import, type Outline, type Range, STUB_MARKER } from './outline.ts';

const require = createRequire(import.meta.url);

let runtime: Promise<void> | undefined;
const grammars = new Map<string, Promise<Language>>();

async function grammar(spec: LanguageSpec): Promise<Language> {
	runtime ??= Parser.init();
	await runtime;
	let loading = grammars.get(spec.id);
	if (!loading) {
		loading = Language.load(require.resolve(spec.wasm));
		grammars.set(spec.id, loading);
	}
	return loading;
}

/** A parser for one language, ready to use with no wait. */
export interface Syntax {
	language: LanguageSpec;
	outline(text: string): Outline;
}

/** The syntax for a file, by its name; undefined when its language is not known. */
export async function syntaxFor(path: string): Promise<Syntax | undefined> {
	const spec = languageOf(path);
	if (!spec) return undefined;
	const language = await grammar(spec);
	return {
		language: spec,
		outline(text) {
			const parser = new Parser();
			try {
				parser.setLanguage(language);
				const tree = parser.parse(text);
				if (!tree) throw new Error(`tree-sitter could not parse the ${spec.id} text`);
				try {
					return outlineOf(spec, tree.rootNode);
				} finally {
					tree.delete();
				}
			} finally {
				parser.delete();
			}
		},
	};
}

const range = (node: Node): Range => ({ start: node.startIndex, end: node.endIndex });

/** The node the doc comment sits above: the function or declaration, or the statement that holds it. */
function anchorOf(spec: LanguageSpec, start: Node): Node {
	let node = start;
	while (node.parent && spec.holders.includes(node.parent.type) && (spec.holds?.(node.parent) ?? true)) node = node.parent;
	return node;
}

const isComment = (node: Node) => node.type.includes('comment');

/** A comment's text without its marks: `/** a *\/` → `a`, `-- a` → `a`. */
function clean(comment: string): string {
	return comment
		.replace(/^\/\*\*?|\*\/$/g, '')
		.split('\n')
		.map((line) => line.replace(/^\s*(\/\/\/?|#|--|\*)?\s?/, '').trimEnd())
		.join('\n')
		.trim();
}

/** The comments right above `anchor`, with no blank line between them and it; the nearest last. */
function commentsAbove(anchor: Node): Node[] {
	const comments: Node[] = [];
	let row = anchor.startPosition.row;
	for (let node = anchor.previousNamedSibling; node && isComment(node); node = node.previousNamedSibling) {
		if (node.endPosition.row < row - 1) break;
		comments.unshift(node);
		row = node.startPosition.row;
	}
	return comments;
}

function intentAbove(anchor: Node): string | null {
	const comments = commentsAbove(anchor);
	return comments.length > 0 ? comments.map((c) => clean(c.text)).join('\n') : null;
}

/** The statements and comments in the body, with the wrapping nodes opened. */
function bodyItems(spec: LanguageSpec, fn: Node, body: Range): Node[] {
	const open = (node: Node): Node[] => (spec.wrappers.includes(node.type) ? node.namedChildren.flatMap(open) : [node]);
	const top = fn.namedChildren.filter((c) => contains(body, range(c)));
	const inside = isBraces(spec, top, body) ? top[0].namedChildren : top;
	return inside.flatMap(open);
}

/** The body is one node that spans it (the braces), not a statement: look inside it. */
function isBraces(spec: LanguageSpec, top: Node[], body: Range): boolean {
	if (top.length !== 1) return false;
	const [node] = top;
	return node.startIndex === body.start && node.endIndex === body.end && !spec.placeholder(node);
}

function isStub(spec: LanguageSpec, items: Node[]): boolean {
	return items.some((n) => isComment(n) && n.text.includes(STUB_MARKER)) && items.every((n) => isComment(n) || spec.placeholder(n));
}

/** A Python docstring: the body's first statement is a string. */
function docstring(items: Node[]): string | null {
	const first = items.find((n) => !isComment(n));
	if (first?.type !== 'expression_statement' || first.namedChildren[0]?.type !== 'string') return null;
	const content = first.namedChildren[0].descendantsOfType('string_content')[0];
	return content ? content.text.trim() : null;
}

function functions(spec: LanguageSpec, root: Node): Fn[] {
	const out: Fn[] = [];
	for (const fn of root.descendantsOfType(spec.functions)) {
		const parts = spec.split(fn);
		if (!parts) continue;
		const anchor = anchorOf(spec, fn);
		const items = bodyItems(spec, fn, parts.body);
		out.push({
			name: spec.name(fn),
			range: { start: anchor.startIndex, end: Math.max(anchor.endIndex, fn.endIndex) },
			signature: parts.signature,
			body: parts.body,
			intent: intentAbove(anchor) ?? docstring(items),
			line: anchor.startPosition.row + 1,
			endLine: fn.endPosition.row + 1,
			stub: isStub(spec, items),
		});
	}
	return out;
}

function declName(spec: LanguageSpec, node: Node): string {
	return spec.declName ? spec.declName(node) : (node.childForFieldName('name')?.text ?? '');
}

/** Every declaration, not looking into function bodies. */
function declarations(spec: LanguageSpec, root: Node): Decl[] {
	const out: Decl[] = [];
	const walk = (node: Node, parentIsDecl: boolean) => {
		const isDecl = spec.declarations.includes(node.type);
		if (isDecl && !parentIsDecl) {
			const name = declName(spec, node);
			const anchor = anchorOf(spec, node);
			const comments = commentsAbove(anchor);
			out.push({
				kind: node.type,
				name,
				range: { start: anchor.startIndex, end: Math.max(anchor.endIndex, node.endIndex) },
				doc: comments.length > 0 ? { start: comments[0].startIndex, end: comments[comments.length - 1].endIndex } : null,
				private: spec.isPrivate(node, name),
			});
		}
		const body = spec.functions.includes(node.type) ? spec.split(node)?.body : undefined;
		for (const child of node.namedChildren) {
			if (body && contains(body, range(child))) continue;
			walk(child, isDecl);
		}
	};
	walk(root, false);
	return out;
}

function imports(spec: LanguageSpec, root: Node): Import[] {
	return spec.imports(root).map(({ spec: s, node }) => ({ spec: s, range: range(node) }));
}

export function outlineOf(spec: LanguageSpec, root: Node): Outline {
	return { language: spec.id, functions: functions(spec, root), imports: imports(spec, root), decls: declarations(spec, root), broken: root.hasError };
}
