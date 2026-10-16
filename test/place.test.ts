// A new function under its description: finding the place, and the guard on it,
// in the languages symbiosis parses.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Allowance, guard } from '../core/guard.ts';
import { describeAt, findPlace, inBody, type PlaceRef, placeMessage } from '../core/place.ts';
import { syntaxFor } from '../core/syntax/parse.ts';

const all = () => true;

async function check(path: string, before: string, after: string, line: number, allowances: Allowance[] = []) {
	const syntax = await syntaxFor(path);
	assert.ok(syntax, path);
	const described = describeAt(before, line);
	assert.ok(described, `a description at line ${line}`);
	const place: PlaceRef = { kind: 'place', path, description: described.description, line: described.line, name: '' };
	return guard({
		scope: 'stub',
		target: place,
		path,
		before: { text: before, outline: syntax.outline(before) },
		after: { text: after, outline: syntax.outline(after) },
		resolves: all,
		allowances,
	});
}

test('the description is the comment lines that end at the line', () => {
	const text = 'x = 1\n\n# parse the header\n# and return its fields\n\ny = 2\n';
	assert.deepEqual(describeAt(text, 4), { description: '# parse the header\n# and return its fields', line: 3 });
	assert.equal(describeAt(text, 5), undefined, 'a blank line is no comment');
	assert.equal(describeAt(text, 1), undefined);
});

test('the place is found again by its text, nearest its old line', async () => {
	const syntax = await syntaxFor('/w/a.ts');
	assert.ok(syntax);
	const text = '// twice\n\nconst a = 1;\n\n// twice\n';
	const ref: PlaceRef = { kind: 'place', path: '/w/a.ts', description: '// twice', line: 5, name: '' };
	assert.equal(findPlace(syntax.outline(text), text, ref)?.line, 5);
	assert.equal(findPlace(syntax.outline(text), text, { ...ref, line: 1 })?.line, 1);
	assert.equal(findPlace(syntax.outline(text), text, { ...ref, description: '// gone' }), undefined);
});

test('a comment in a body is in a body', async () => {
	const syntax = await syntaxFor('/w/a.ts');
	assert.ok(syntax);
	const text = 'function f() {\n\t// here\n}\n// there\n';
	assert.ok(inBody(syntax.outline(text), text.indexOf('// here')));
	assert.ok(!inBody(syntax.outline(text), text.indexOf('// there')));
});

test('the message asks for the whole function under the description', () => {
	const message = placeMessage('src/a.ts', { kind: 'place', path: '/w/src/a.ts', description: '// one\n// two', line: 4, name: '' });
	assert.match(message, /^Write a new function in src\/a\.ts, directly under the description at line 4-5:\n```\n\/\/ one\n\/\/ two\n```/);
	assert.match(message, /call `propose`/);
});

const PY = 'import os\n\nLIMIT = 3\n\n# clamp n between 0 and LIMIT\n\n\ndef other():\n    return 1\n';
const PY_FN = 'def clamp(n):\n    return min(LIMIT, max(0, n))\n';

test('python: the function directly under the description goes through', async () => {
	const ok = await check('/w/a.py', PY, PY.replace('# clamp n between 0 and LIMIT\n', `# clamp n between 0 and LIMIT\n${PY_FN}`), 5);
	assert.deepEqual(ok.violations, []);
	assert.equal(ok.target?.kind === 'place' && ok.target.name, 'clamp');
});

test('python: a second function, or a changed constant, is blocked', async () => {
	const two = await check('/w/a.py', PY, PY.replace('# clamp n between 0 and LIMIT\n', `# clamp n between 0 and LIMIT\n${PY_FN}\n\ndef helper():\n    return 2\n`), 5);
	assert.deepEqual(
		two.violations.map((v) => [v.kind, v.target]),
		[['new_decl', 'helper']],
	);
	const constant = await check('/w/a.py', PY, PY.replace('LIMIT = 3', 'LIMIT = 4').replace('# clamp n between 0 and LIMIT\n', `# clamp n between 0 and LIMIT\n${PY_FN}`), 5);
	assert.deepEqual(
		constant.violations.map((v) => v.kind),
		['outside_edit'],
	);
	const allowed = await check('/w/a.py', PY, PY.replace('# clamp n between 0 and LIMIT\n', `# clamp n between 0 and LIMIT\n${PY_FN}\n\ndef helper():\n    return 2\n`), 5, [
		{ kind: 'new_decl', target: 'helper' },
	]);
	assert.ok(allowed.ok, 'an accepted proposal lets the helper through');
});

const GO = 'package main\n\nimport "fmt"\n\n// Clamp keeps n between 0 and 3.\n\nfunc other() int { return 1 }\n';

test('go: the function and a new import go through', async () => {
	const after = GO.replace('import "fmt"', 'import "fmt"\nimport "math"').replace(
		'// Clamp keeps n between 0 and 3.\n',
		'// Clamp keeps n between 0 and 3.\nfunc Clamp(n float64) float64 { return math.Max(0, math.Min(3, n)) }\n',
	);
	const r = await check('/w/a.go', GO, after, 5);
	assert.deepEqual(r.violations, []);
});

const LUA = 'local M = {}\n\n-- clamp n between 0 and 3\n\nreturn M\n';

test('lua: the function under the description; editing return M is outside', async () => {
	const fn = 'function M.clamp(n)\n\treturn math.max(0, math.min(3, n))\nend\n';
	const ok = await check('/w/a.lua', LUA, LUA.replace('-- clamp n between 0 and 3\n', `-- clamp n between 0 and 3\n${fn}`), 3);
	assert.deepEqual(ok.violations, []);
	const outside = await check('/w/a.lua', LUA, LUA.replace('-- clamp n between 0 and 3\n', `-- clamp n between 0 and 3\n${fn}`).replace('return M', 'return { M }'), 3);
	assert.deepEqual(
		outside.violations.map((v) => v.kind),
		['outside_edit'],
	);
});

test('the description must stay as it is', async () => {
	const r = await check('/w/a.py', PY, PY.replace('# clamp n between 0 and LIMIT\n', `# clamp n to LIMIT\n${PY_FN}`), 5);
	assert.match(r.reason, /changes or removes the description/);
});
