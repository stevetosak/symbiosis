import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Changes, keyOf } from '../pi/changes.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'symbiosis-'));
const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf-8'));

test('a file changed twice in a run: before is from the first touch, after from the last', () => {
	const ws = temp();
	const dir = join(temp(), 'changes');
	const file = join(ws, 'a.ts');
	writeFileSync(file, 'one\n');
	const c = new Changes(dir, () => 5000);
	c.start('s1');
	c.before(file);
	writeFileSync(file, 'two\n');
	c.after(file);
	c.before(file);
	writeFileSync(file, 'three\n');
	c.after(file);
	assert.deepEqual(read(dir, `${keyOf(file)}.json`), { path: file, before: 'one\n', after: 'three\n' });
	assert.deepEqual(read(dir, 'index.json'), { session: 's1', turn: 5000, files: [{ path: file, key: keyOf(file), t: 5 }] });
});

test('a new file has no before; the last changed file is listed last', () => {
	const ws = temp();
	const dir = join(temp(), 'changes');
	const a = join(ws, 'a.ts');
	const b = join(ws, 'b.ts');
	writeFileSync(a, 'a\n');
	const c = new Changes(dir);
	c.start('s1');
	c.before(a);
	c.before(b);
	writeFileSync(b, 'new\n');
	c.after(b);
	c.after(a);
	assert.equal(read(dir, `${keyOf(b)}.json`).before, null);
	assert.deepEqual(read(dir, 'index.json').files.map((f: { path: string }) => f.path), [b, a]);
});

test('a new run drops the last run', () => {
	const ws = temp();
	const dir = join(temp(), 'changes');
	const a = join(ws, 'a.ts');
	writeFileSync(a, 'a\n');
	const c = new Changes(dir);
	c.start('s1');
	c.before(a);
	c.after(a);
	c.start('s1');
	assert.equal(existsSync(join(dir, 'index.json')), false);
	c.after(a);
	assert.equal(existsSync(join(dir, 'index.json')), false);
});
