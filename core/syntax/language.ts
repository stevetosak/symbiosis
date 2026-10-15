// What one language tells the outline builder (./parse.ts). Node shapes
// differ per grammar; everything else is shared. A new language is one new
// file in ./languages/ and one line in ./languages/index.ts.
import type { Node } from 'web-tree-sitter';
import type { Range } from './outline.ts';

export interface LanguageSpec {
	id: string;
	/** File name endings, with the dot: `.ts`. */
	extensions: string[];
	/** The grammar's `.wasm`, as a module path: `tree-sitter-go/tree-sitter-go.wasm`. */
	wasm: string;
	/** Node types that are functions or methods. */
	functions: string[];
	/** The signature and the body of a function node; undefined when it has no body (an interface method). */
	split(fn: Node): { signature: Range; body: Range } | undefined;
	/** Its name; "" when it has none. */
	name(fn: Node): string;
	/** Node types that only wrap the statements of a body: their children are looked at instead. */
	wrappers: string[];
	/** A statement that stands for "not written yet": `throw new Error()`, `TODO()`, `pass`. */
	placeholder(node: Node): boolean;
	/** The imports of the file. */
	imports(root: Node): { spec: string; node: Node }[];
	/** Node types that declare something: functions, classes, members, constants. */
	declarations: string[];
	/**
	 * Node types that hold a function on its way up to the statement the doc
	 * comment sits above: `export`, `const f = () => {}`, a Python decorator.
	 */
	holders: string[];
	/** A holder of one of `holders` counts only when this is true: a Go `var ( ... )` holds several. */
	holds?(holder: Node): boolean;
	/** True when the declaration is not visible outside its file or class. */
	isPrivate(decl: Node, name: string): boolean;
	/** A declaration's name, when the `name` field does not hold it. */
	declName?(decl: Node): string;
}

/** The text of a node from its start to the start of `child`: the modifiers before a name. */
export function before(node: Node, child: Node | null): string {
	return child ? node.text.slice(0, child.startIndex - node.startIndex) : node.text;
}

/** The first named child of one of `types`. */
export function childOfType(node: Node, types: string[]): Node | null {
	return node.namedChildren.find((c) => types.includes(c.type)) ?? null;
}

/** The body as the braces' node: the signature is everything before it. */
export function splitAtBody(fn: Node, body: Node | null): { signature: Range; body: Range } | undefined {
	if (!body) return undefined;
	return { signature: { start: fn.startIndex, end: body.startIndex }, body: { start: body.startIndex, end: body.endIndex } };
}

/** The name field's text, else "". */
export function nameField(fn: Node): string {
	return fn.childForFieldName('name')?.text ?? '';
}

/** A call whose callee is the identifier `name`. */
export function callTo(node: Node | null, name: string): boolean {
	if (!node) return false;
	const callee = node.childForFieldName('function') ?? node.childForFieldName('name') ?? node.namedChildren[0] ?? null;
	return callee?.type === 'identifier' && callee.text === name;
}
