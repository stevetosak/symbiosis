import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fill } from '../core/fill.ts';
import { addLanded, BODY_MAX, capLines, dedent, type Landed, landingOf, parseReviewRequest } from '../core/review.ts';
import { syntaxFor } from '../core/syntax/parse.ts';

const SOURCE = [
	"import { readFile } from 'node:fs/promises';",
	'',
	'/** Sum the numbers in a file, one per line. */',
	'export async function sumFile(path: string,',
	'\tscale: number): Promise<number> {',
	"\tconst data = await readFile(path, 'utf8');",
	'',
	'\tif (data === "") {',
	'\t\treturn 0;',
	'\t}',
	'\treturn data.split("\\n").map(Number).reduce((a, b) => a + b, 0) * scale;',
	'}',
	'',
].join('\n');

test('dedent cuts blank edge lines and the indent every line shares', () => {
	assert.equal(dedent('\n\t\ta\n\n\t\t\tb\n\t\t'), 'a\n\n    b');
	assert.equal(dedent('  x\n  y'), 'x\ny');
	assert.equal(dedent('   \n'), '');
});

test('capLines keeps a short text and marks a cut one', () => {
	assert.equal(capLines('a\nb', 5), 'a\nb');
	assert.equal(capLines('a\nb\nc', 2), 'a\nb\n…');
	assert.equal(capLines(Array.from({ length: BODY_MAX + 1 }, () => 'x').join('\n')).split('\n').length, BODY_MAX + 1);
});

test('landingOf: signature on one line, intent, body without indent, anchor line', async () => {
	const syntax = await syntaxFor('a.ts');
	assert.ok(syntax);
	const fn = syntax.outline(SOURCE).functions[0];
	assert.ok(fn);
	const landing = landingOf('/w/a.ts', SOURCE, fn);
	assert.equal(landing.path, '/w/a.ts');
	assert.equal(landing.name, 'sumFile');
	assert.equal(landing.line, 4);
	assert.equal(landing.endLine, 12);
	assert.equal(landing.signature, 'export async function sumFile(path: string, scale: number): Promise<number>');
	assert.equal(landing.intent, 'Sum the numbers in a file, one per line.');
	assert.equal(landing.anchor, 'export async function sumFile(path: string,');
	assert.match(landing.body, /^const data = await readFile\(path, 'utf8'\);\n\nif \(data === ""\) \{\n {4}return 0;\n\}\nreturn data/);
});

test('Fill.landing: none while the body is a stub, the function once it is filled', async () => {
	const stub = SOURCE.replace(/\{\n\tconst data[\s\S]*\n\}\n$/, '{\n\t// TODO(pi)\n\tthrow new Error("not written");\n}\n');
	let text = stub;
	const started = await Fill.start({ mode: 'stub', path: '/w/a.ts', line: 5, shown: 'a.ts', root: '/w', read: () => text });
	assert.ok('fill' in started, 'error' in started ? started.error : '');
	const fill = started.fill;
	assert.equal(await fill.landing(), undefined);
	assert.equal(await fill.filled(), false);
	text = SOURCE;
	assert.equal(await fill.filled(), true);
	const landing = await fill.landing();
	assert.equal(landing?.name, 'sumFile');
	assert.match(landing?.body ?? '', /reduce/);
});

test('Fill.landing of a new function is the first function in it', async () => {
	let text = '// Add two numbers.\n// helpi!\n';
	const started = await Fill.start({ mode: 'function', path: '/w/b.ts', line: 1, shown: 'b.ts', root: '/w', read: () => text });
	assert.ok('fill' in started, 'error' in started ? started.error : '');
	assert.equal(await started.fill.landing(), undefined, 'no function yet');
	text = '// Add two numbers.\nexport function add(a: number, b: number): number {\n\treturn a + b;\n}\n';
	const landing = await started.fill.landing();
	assert.equal(landing?.name, 'add');
	assert.equal(landing?.body, 'return a + b;');
});

const landed = (path: string, name: string, id: string): Landed => ({
	path, name, line: 1, endLine: 2, signature: name, intent: '', body: '', anchor: name, id, whys: [], time: 1,
});

test('addLanded: a function filled again replaces the old entry; the newest last; capped', () => {
	let list = addLanded([], landed('/a', 'f', '1'));
	list = addLanded(list, landed('/a', 'g', '2'));
	list = addLanded(list, landed('/a', 'f', '3'));
	assert.deepEqual(list.map((l) => l.id), ['2', '3']);
	for (let i = 0; i < 30; i++) list = addLanded(list, landed('/b', `n${i}`, `x${i}`));
	assert.equal(list.length, 20);
	assert.equal(list.at(-1)?.id, 'x29');
});

test('parseReviewRequest needs id, to and ack as text', () => {
	assert.deepEqual(parseReviewRequest({ id: 'r1', to: 's', ack: 'a' }), { id: 'r1', to: 's', ack: 'a' });
	assert.equal(parseReviewRequest({ id: 'r1', to: 's' }), undefined);
	assert.equal(parseReviewRequest(null), undefined);
	assert.equal(parseReviewRequest({ id: 1, to: 's', ack: 'a' }), undefined);
});
