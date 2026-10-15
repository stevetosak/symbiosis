import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fillMessage, locate, normalize, stubAt, stubRef } from '../core/stubs.ts';
import { syntaxFor } from '../core/syntax/parse.ts';

const TEXT = `/** Outer. */
function outer(a: number): number {
	// TODO(pi)
	throw new Error();
}

class A {
	/** Inner. */
	inner(): void {
		// TODO(pi)
	}
}
`;

async function outline(text: string) {
	const syntax = await syntaxFor('a.ts');
	assert.ok(syntax);
	return syntax.outline(text);
}

test('stubAt finds the stub on a line, and nothing between stubs', async () => {
	const o = await outline(TEXT);
	assert.equal(stubAt(o, 3)?.name, 'outer');
	assert.equal(stubAt(o, 10)?.name, 'inner');
	assert.equal(stubAt(o, 6), undefined);
});

test('locate follows the stub when lines move, and by name when asked', async () => {
	const o = await outline(TEXT);
	const fn = stubAt(o, 3);
	assert.ok(fn);
	const ref = stubRef('/p/a.ts', TEXT, fn);
	assert.equal(ref.signature, 'function outer(a: number): number');
	const moved = `// one\n// two\n${TEXT}`;
	assert.equal(locate(await outline(moved), moved, ref)?.line, 4);
	const renamed = TEXT.replace('outer(a: number)', 'outer(a: string)');
	const o2 = await outline(renamed);
	assert.equal(locate(o2, renamed, ref), undefined);
	assert.equal(locate(o2, renamed, ref, true)?.name, 'outer');
});

test('normalize collapses whitespace', () => {
	assert.equal(normalize('  a\n\t b  '), 'a b');
});

test('the fill message holds the stub, the intent and the rules', async () => {
	const o = await outline(TEXT);
	const fn = stubAt(o, 3);
	assert.ok(fn);
	const message = fillMessage('src/a.ts', TEXT, fn);
	assert.match(message, /Fill the stub `outer` in src\/a\.ts \(lines 2-5\)/);
	assert.match(message, /Intent: Outer\./);
	assert.match(message, /function outer\(a: number\): number/);
	assert.match(message, /call `propose`/);
});
