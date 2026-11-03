import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AgentSide } from '../core/agent/agent.ts';

function setup(owner: string) {
	const base = realpathSync(mkdtempSync(join(tmpdir(), 'symbiosis-agent-')));
	const dir = join(base, 'plugin');
	const ws = join(base, 'ws');
	mkdirSync(dir);
	mkdirSync(ws);
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner }));
	const calls = { stop: 0, quit: 0 };
	const side = new AgentSide({
		id: 'a1',
		agent: 'claude',
		can: ['stop'],
		cwd: ws,
		pid: 4242,
		env: {},
		dir,
		host: {
			stop: () => calls.stop++,
			quit: () => calls.quit++,
		},
	});
	side.begin(ws);
	const events = () => readFileSync(join(dir, 'events.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
	const record = () => JSON.parse(readFileSync(join(dir, 'sessions', 'a1.json'), 'utf-8'));
	const log = () => JSON.parse(readFileSync(join(dir, 'log', 'a1', 'index.json'), 'utf-8'));
	return { dir, ws, side, calls, events, record, log };
}

test('the owner sends a call from start to stop, and keeps it for the change list and the diff key', () => {
	const { dir, ws, side, events, record, log } = setup('a1');
	const file = join(ws, 'a.ts');
	writeFileSync(file, 'one\n');
	side.turnStart();
	side.ready('c1', 'edit', { path: 'a.ts', edits: [{ oldText: 'one', newText: 'two' }] }, ws);
	writeFileSync(file, 'two\n');
	side.done('c1', 'edit', { path: 'a.ts' }, ws, true, 1, 'the name says two');
	side.turnEnd();
	const ops = events().map((e) => (e.op === 'text' ? `text:${e.key}` : e.op));
	assert.deepEqual(ops, ['start', 'text:edits.0.old', 'text:edits.0.new', 'ready', 'done', 'stop']);
	const done = events().find((e) => e.op === 'done');
	assert.equal(done.path, file);
	assert.equal(done.why, 'the name says two');
	assert.equal(record().working, false);
	assert.equal(record().agent, 'claude');
	assert.deepEqual(record().can, ['stop']);
	assert.deepEqual(record().files, [file]);
	assert.equal(log().changes.length, 1);
	assert.equal(JSON.parse(readFileSync(join(dir, 'changes', 'index.json'), 'utf-8')).files[0].path, file);
});

test('a session the editor does not follow sends no events but logs its changes', () => {
	const { ws, side, dir, log } = setup('someone-else');
	const file = join(ws, 'b.ts');
	side.turnStart();
	side.ready('c1', 'write', { path: file, content: 'new\n' }, ws);
	writeFileSync(file, 'new\n');
	side.done('c1', 'write', { path: file }, ws, true, 1);
	side.turnEnd();
	assert.throws(() => readFileSync(join(dir, 'events.jsonl'), 'utf-8'));
	assert.equal(log().changes[0].created, true);
});

test('a blocked call is aborted with the reason; a call open at the end of a turn is aborted', () => {
	const { ws, side, events } = setup('a1');
	side.turnStart();
	side.stream('c1', 'write', { path: 'x.ts', content: 'x' }, ws, false);
	side.blocked('c1', 'outside the stub');
	side.stream('c2', 'write', { path: 'y.ts', content: 'y' }, ws, false);
	side.turnEnd();
	const aborts = events().filter((e) => e.op === 'abort');
	assert.deepEqual(aborts, [
		{ op: 'abort', call: 'c1', reason: 'outside the stub' },
		{ op: 'abort', call: 'c2' },
	]);
});

test('stop and close requests reach the host once each, and only for this session', () => {
	const { dir, side, calls } = setup('a1');
	writeFileSync(join(dir, 'stop.json'), JSON.stringify({ id: 's1', to: 'other' }));
	side.poll();
	assert.equal(calls.stop, 0);
	writeFileSync(join(dir, 'stop.json'), JSON.stringify({ id: 's2', to: 'a1' }));
	writeFileSync(join(dir, 'close.json'), JSON.stringify({ id: 'q1', to: 'a1' }));
	side.poll();
	side.poll();
	assert.deepEqual(calls, { stop: 1, quit: 1 });
});
