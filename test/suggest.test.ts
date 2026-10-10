import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { findMarkers, parseMarkers, suggestionMessage } from '../pi/suggest.ts';

const code = `// A store for to-do items. Split this file in two AI!

import { x } from './x.ts';

// Why a class and not functions? AI?
export class Store {
	private next = 1; // start at 0 AI!
	/* make this private AI! */
	add() {}
	// AI is fine in a normal comment
	label = "AI!";
}
`;

test('markers: kind, note, reach and the code they point at', () => {
	assert.deepEqual(parseMarkers('/w/a.ts', code), [
		{ path: '/w/a.ts', line: 1, kind: '!', note: 'A store for to-do items. Split this file in two', scope: 'file', target: "import { x } from './x.ts';" },
		{ path: '/w/a.ts', line: 5, kind: '?', note: 'Why a class and not functions?', scope: 'block', target: 'export class Store {' },
		{ path: '/w/a.ts', line: 7, kind: '!', note: 'start at 0', scope: 'line', target: 'private next = 1;' },
		{ path: '/w/a.ts', line: 8, kind: '!', note: 'make this private', scope: 'block', target: 'add() {}' },
	]);
});

test('other comment styles', () => {
	const kinds = (text: string) => parseMarkers('f', text).map((m) => `${m.kind} ${m.note}`);
	assert.deepEqual(kinds('x = 1  # rename AI!\n'), ['! rename']);
	assert.deepEqual(kinds('<!-- why this tag? AI? -->\n<div>\n'), ['? why this tag?']);
	assert.deepEqual(kinds('select 1; -- index this AI!\n'), ['! index this']);
	assert.deepEqual(kinds('const a = "AI!"\n'), []);
});

test('a marker on its own line below code reaches the block, not the file', () => {
	const [m] = parseMarkers('f', 'let a = 1;\n// fix AI!\n\nfunction f() {}\n');
	assert.deepEqual([m.scope, m.target], ['block', 'function f() {}']);
});

test('findMarkers searches a git repository, including untracked files, and extra files', () => {
	const dir = mkdtempSync(join(tmpdir(), 'symbiosis-'));
	execFileSync('git', ['init', '-q'], { cwd: dir });
	mkdirSync(join(dir, 'src'));
	writeFileSync(join(dir, 'src/a.ts'), 'let a = 1; // name it count AI!\n');
	writeFileSync(join(dir, 'b.ts'), 'let b = 2;\n');
	const other = join(mkdtempSync(join(tmpdir(), 'symbiosis-')), 'c.py');
	writeFileSync(other, 'c = 3  # why 3? AI?\n');
	const found = findMarkers(dir, [other]).map((m) => `${m.path.replace(dir, '<repo>')}:${m.line}`);
	assert.deepEqual(found.sort(), [`${other}:1`, '<repo>/src/a.ts:1'].sort());
});

test('the message: one line per marker, paths relative to cwd', () => {
	const text = suggestionMessage(parseMarkers('/w/src/a.ts', 'let n = 1; // name it count AI!\n'), '/w');
	assert.match(text, /^Suggestions from the editor\./);
	assert.match(text, /- src\/a\.ts:1 AI! \(this line\) name it count\n {2}at: let n = 1;$/);
});
