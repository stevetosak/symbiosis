import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Outline } from '../core/syntax/outline.ts';
import { syntaxFor } from '../core/syntax/parse.ts';

const FIXTURES = new URL('./fixtures/stubs/', import.meta.url);

async function outline(file: string): Promise<{ text: string; outline: Outline }> {
	const path = new URL(file, FIXTURES).pathname;
	const syntax = await syntaxFor(path);
	assert.ok(syntax, `no syntax for ${file}`);
	const text = readFileSync(path, 'utf8');
	return { text, outline: syntax.outline(text) };
}

const stubs = (o: Outline) => o.functions.filter((f) => f.stub).map((f) => ({ name: f.name, intent: f.intent }));
const INTENT = 'Sum the numbers in a file, one per line.';

test('a file of an unknown language has no syntax', async () => {
	assert.equal(await syntaxFor('notes.md'), undefined);
});

test('TypeScript: stubs, intents, imports, private declarations', async () => {
	const { outline: o } = await outline('sample.ts');
	assert.deepEqual(stubs(o), [
		{ name: 'sumFile', intent: INTENT },
		{ name: 'put', intent: 'Keep the value for `key`.' },
	]);
	assert.deepEqual(o.imports.map((i) => i.spec), ['node:fs/promises', './helper.ts']);
	const priv = o.decls.filter((d) => d.private).map((d) => d.name);
	assert.deepEqual(priv, ['LIMIT', 'size']);
});

test('TypeScript: signature ends where the body starts', async () => {
	const { text, outline: o } = await outline('sample.ts');
	const fn = o.functions.find((f) => f.name === 'sumFile');
	assert.ok(fn);
	assert.equal(text.slice(fn.signature.start, fn.signature.end).trim(), 'async function sumFile(path: string): Promise<number>');
	assert.ok(text.slice(fn.body.start, fn.body.end).startsWith('{'));
	// The range starts at `export`, so the doc comment sits above it.
	assert.ok(text.slice(fn.range.start).startsWith('export async'));
	assert.deepEqual([fn.line, fn.endLine], [7, 10]);
});

test('Kotlin', async () => {
	const { outline: o } = await outline('sample.kt');
	assert.deepEqual(stubs(o), [
		{ name: 'sumFile', intent: INTENT },
		{ name: 'put', intent: 'Keep the value for `key`.' },
	]);
	assert.deepEqual(o.imports.map((i) => i.spec), ['kotlin.math.max', 'java.io.File']);
	assert.deepEqual(o.decls.filter((d) => d.private).map((d) => d.name), ['LIMIT', 'size']);
});

test('C#: a member with no modifier is private', async () => {
	const { outline: o } = await outline('sample.cs');
	assert.deepEqual(stubs(o), [{ name: 'SumFile', intent: INTENT }]);
	assert.deepEqual(o.imports.map((i) => i.spec), ['System', 'System.IO']);
	assert.deepEqual(o.decls.filter((d) => d.private).map((d) => d.name), ['size']);
});

test('Go: a lower-case name is private', async () => {
	const { outline: o } = await outline('sample.go');
	assert.deepEqual(stubs(o), [{ name: 'SumFile', intent: `SumFile sums the numbers in a file, one per line.` }]);
	assert.deepEqual(o.imports.map((i) => i.spec), ['fmt', 'os']);
	assert.deepEqual(o.decls.filter((d) => d.private).map((d) => d.name), ['limit', 'get']);
});

test('Python: the intent is the docstring', async () => {
	const { outline: o } = await outline('sample.py');
	assert.deepEqual(stubs(o), [{ name: 'sum_file', intent: INTENT }]);
	assert.deepEqual(o.imports.map((i) => i.spec), ['os', 'pathlib']);
	assert.deepEqual(o.decls.filter((d) => d.private).map((d) => d.name), ['_get']);
});

test('Lua: an empty body is a stub; require is an import', async () => {
	const { outline: o } = await outline('sample.lua');
	assert.deepEqual(stubs(o), [{ name: 'sum_file', intent: INTENT }]);
	assert.deepEqual(o.imports.map((i) => i.spec), ['util']);
	assert.deepEqual(o.decls.filter((d) => d.private).map((d) => d.name), ['util', 'LIMIT', 'sum_file']);
});

test('a body with real code next to the marker is not a stub', async () => {
	const syntax = await syntaxFor('a.ts');
	assert.ok(syntax);
	const o = syntax.outline('function f() {\n\t// TODO(pi)\n\treturn 1;\n}\nfunction g() {\n\t// TODO: later\n}\n');
	assert.deepEqual(o.functions.map((f) => f.stub), [false, false]);
});

test('an arrow function takes the name of its variable', async () => {
	const syntax = await syntaxFor('a.ts');
	assert.ok(syntax);
	const o = syntax.outline('/** Double it. */\nexport const twice = (n: number) => {\n\t// TODO(pi)\n};\n');
	assert.deepEqual(stubs(o), [{ name: 'twice', intent: 'Double it.' }]);
});

test('a comment with a blank line under it is not the intent', async () => {
	const syntax = await syntaxFor('a.go');
	assert.ok(syntax);
	const o = syntax.outline('package a\n\n// Unrelated.\n\nfunc f() {\n\t// TODO(pi)\n}\n');
	assert.equal(o.functions[0].intent, null);
	assert.equal(o.functions[0].stub, true);
});
