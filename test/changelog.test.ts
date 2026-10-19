import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hunksOf, moveLine } from '../core/hunks.ts';
import { ChangeLog, MAX_CHANGES, stepOf } from '../pi/changelog.ts';
import type { Step } from '../core/protocol.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'symbiosis-log-'));
const index = (root: string, session: string) => JSON.parse(readFileSync(join(root, session, 'index.json'), 'utf-8'));

test('hunks: an insert, a delete, a replace, a new file', () => {
	assert.deepEqual(hunksOf('a\nb\nc\n', 'a\nX\nb\nc\n'), [{ oldStart: 2, oldLines: 0, newStart: 2, newLines: 1 }]);
	assert.deepEqual(hunksOf('a\nb\nc\n', 'a\nc\n'), [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 0 }]);
	assert.deepEqual(hunksOf('a\nb\nc\n', 'a\nB\nc\n'), [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
	assert.deepEqual(hunksOf(null, 'x\ny\n'), [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }]);
	assert.deepEqual(hunksOf('same\n', 'same\n'), []);
});

test('moveLine: lines move down with an insert above, stay above it, and are lost when replaced', () => {
	const insert = hunksOf('a\nb\nc\n', 'a\nX\nY\nb\nc\n');
	assert.equal(moveLine(1, insert), 1);
	assert.equal(moveLine(2, insert), 4);
	assert.equal(moveLine(3, insert), 5);
	const replace = hunksOf('a\nb\nc\n', 'a\nB\nc\n');
	assert.equal(moveLine(2, replace), null);
	assert.equal(moveLine(3, replace), 3);
	const del = hunksOf('a\nb\nc\n', 'a\nc\n');
	assert.equal(moveLine(3, del), 2);
});

test('the step of a change: the step that is now, else the last done one, else none', () => {
	const plan: Step[] = [
		{ text: 'a', state: 'done' },
		{ text: 'b', state: 'now' },
		{ text: 'c', state: 'next' },
	];
	assert.deepEqual(stepOf(plan), { step: 1, text: 'b' });
	assert.deepEqual(stepOf([{ text: 'a', state: 'done' }, { text: 'b', state: 'done' }]), { step: 1, text: 'b' });
	assert.equal(stepOf([{ text: 'a', state: 'next' }]), undefined);
	assert.equal(stepOf([]), undefined);
});

test('a write and an edit are logged with their step, hunks and texts', () => {
	const ws = temp();
	const root = join(temp(), 'log');
	const file = join(ws, 'a.ts');
	const log = new ChangeLog(root, 's1', () => 7000);
	const plan: Step[] = [{ text: 'write a', state: 'now' }];

	log.before('c1', file);
	writeFileSync(file, 'one\ntwo\n');
	const first = log.after('c1', 'write', file, plan, 'a new file');
	assert.equal(first?.created, true);
	assert.deepEqual(first?.hunks, [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2 }]);

	log.before('c2', file);
	writeFileSync(file, 'one\nTWO\nthree\n');
	log.after('c2', 'edit', file, [{ text: 'write a', state: 'done' }, { text: 'more', state: 'now' }]);

	const saved = index(root, 's1');
	assert.equal(saved.session, 's1');
	assert.deepEqual(
		saved.changes.map((c: { id: string; seq: number; tool: string; step: number; stepText: string; created: boolean; t: number; why?: string }) => [c.id, c.seq, c.tool, c.step, c.stepText, c.created, c.t, c.why]),
		[
			['1', 1, 'write', 0, 'write a', true, 7, 'a new file'],
			['2', 2, 'edit', 1, 'more', false, 7, undefined],
		],
	);
	assert.deepEqual(saved.changes[1].hunks, [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 2 }]);
	assert.deepEqual(log.texts('2'), { before: 'one\ntwo\n', after: 'one\nTWO\nthree\n' });
});

test('a call that changed nothing, failed, or never started is not logged', () => {
	const ws = temp();
	const root = join(temp(), 'log');
	const file = join(ws, 'a.ts');
	writeFileSync(file, 'x\n');
	const log = new ChangeLog(root, 's1');
	log.before('c1', file);
	assert.equal(log.after('c1', 'edit', file, []), undefined, 'the same text');
	log.before('c2', file);
	log.drop('c2');
	assert.equal(log.after('c2', 'edit', file, []), undefined, 'dropped');
	assert.equal(log.after('c3', 'edit', file, []), undefined, 'no before');
	assert.equal(existsSync(join(root, 's1', 'index.json')), false);
});

test('a big file is logged with its hunks and no texts', () => {
	const ws = temp();
	const root = join(temp(), 'log');
	const file = join(ws, 'big.txt');
	const log = new ChangeLog(root, 's1');
	log.before('c1', file);
	writeFileSync(file, `${'x'.repeat(300 * 1024)}\n`);
	const change = log.after('c1', 'write', file, []);
	assert.equal(change?.texts, false);
	assert.equal(log.texts('1'), undefined);
	assert.equal(change?.hunks.length, 1);
});

test('the log keeps the last changes only, and removes the texts of the others', () => {
	const ws = temp();
	const root = join(temp(), 'log');
	const file = join(ws, 'a.txt');
	const log = new ChangeLog(root, 's1');
	for (let i = 1; i <= MAX_CHANGES + 2; i++) {
		log.before(`c${i}`, file);
		writeFileSync(file, `v${i}\n`);
		log.after(`c${i}`, 'write', file, []);
	}
	const saved = index(root, 's1');
	assert.equal(saved.changes.length, MAX_CHANGES);
	assert.equal(saved.changes[0].seq, 3);
	assert.equal(existsSync(join(root, 's1', '1.json')), false);
	assert.equal(existsSync(join(root, 's1', '3.json')), true);
});

test('the log of an old session goes when a new one starts', () => {
	const root = join(temp(), 'log');
	mkdirSync(join(root, 'old'), { recursive: true });
	mkdirSync(join(root, 'recent'), { recursive: true });
	const longAgo = (Date.now() - 30 * 24 * 3600 * 1000) / 1000;
	utimesSync(join(root, 'old'), longAgo, longAgo);
	new ChangeLog(root, 'now');
	assert.equal(existsSync(join(root, 'old')), false);
	assert.equal(existsSync(join(root, 'recent')), true);
});
