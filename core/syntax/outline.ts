// The outline of a source file: its functions, imports and declarations, as
// plain data. Built from a tree-sitter tree (./parse.ts), then the tree is
// freed; the rules (core/stubs.ts, core/guard.ts) read only this, so they are
// pure and can be tested with no parser.
//
// Every position is an index into the JS string (UTF-16 code units), the
// unit tree-sitter's web binding uses when it parses a string.

/** `[start, end)` in the text. */
export interface Range {
	start: number;
	end: number;
}

export interface Fn {
	/** The name, or "" for an anonymous function that is not assigned. */
	name: string;
	/** The whole function, with what is on its first line before it (`export`, `local`). */
	range: Range;
	/** From the start of the function to its body: name, parameters, result. */
	signature: Range;
	/** What the developer leaves to the agent: inside the braces, after `:` (Python), before `end` (Lua). */
	body: Range;
	/** The doc comment just above (or a Python docstring), without comment marks. */
	intent: string | null;
	/** 1-based lines of `range`. */
	line: number;
	endLine: number;
	/** The body holds a `TODO(pi)` comment and nothing but comments and placeholders. */
	stub: boolean;
}

export interface Import {
	/** What it imports: `./a`, `kotlin.math.max`, `fmt`. */
	spec: string;
	/**
	 * The statement that holds it; one statement may hold several specs
	 * (`import os, sys`). A spec in a Go `import ( ... )` is its own range. A
	 * load inside a function (Python, Lua, a TS `import()`) is here too.
	 */
	range: Range;
}

export interface Decl {
	kind: string;
	name: string;
	/** With what holds it: `export`, a decorator, Go's `var`. */
	range: Range;
	/** The comment block right above it, if any. */
	doc: Range | null;
	/** Not visible outside the file (or outside its class). */
	private: boolean;
}

export interface Outline {
	language: string;
	functions: Fn[];
	imports: Import[];
	/** Every declaration outside function bodies, the classes and their members too. */
	decls: Decl[];
	/** tree-sitter found a syntax error: the outline may miss a function. */
	broken: boolean;
}

/** The marker that makes a function body a stub. */
export const STUB_MARKER = 'TODO(pi)';

export function contains(outer: Range, inner: Range): boolean {
	return outer.start <= inner.start && inner.end <= outer.end;
}
