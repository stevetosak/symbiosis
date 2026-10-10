import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { planPiLink, planTttPlugin } from '../install.ts';
import { Channel } from '../pi/channel.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'symbiosis-'));

test('without the plugin folder the channel writes nothing', () => {
	const dir = join(temp(), 'missing');
	const c = new Channel(dir);
	c.emit({ op: 'abort', call: 'c1' });
	assert.equal(c.enabled(), false);
});

test('events are appended and head.json tracks the size', () => {
	const dir = temp();
	const c = new Channel(dir, () => 1000);
	c.emit({ op: 'ready', call: 'c1' }, { op: 'abort', call: 'c2' });
	const log = readFileSync(join(dir, 'events.jsonl'), 'utf-8');
	assert.deepEqual(log.trim().split('\n').map((l) => JSON.parse(l).call), ['c1', 'c2']);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, 'head.json'), 'utf-8')), { gen: 1000, size: Buffer.byteLength(log) });
});

test('the heartbeat says if ttt is alive and pinned', () => {
	const dir = temp();
	const c = new Channel(dir, () => 10_000);
	assert.deepEqual(c.plugin(), { alive: false, pinned: false });
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, pinned: true }));
	assert.deepEqual(c.plugin(), { alive: true, pinned: true });
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 6 }));
	assert.equal(c.plugin().alive, false);
});

test('the heartbeat names the owner: the session the editor follows', () => {
	const dir = temp();
	const c = new Channel(dir, () => 10_000);
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, owner: 's1' }));
	assert.deepEqual(c.plugin(), { alive: true, pinned: false, owner: 's1' });
});

test('session records are written, removed, and pruned when stale', () => {
	const dir = temp();
	const c = new Channel(dir, () => 100_000);
	const rec = (id: string, t: number) => ({ id, version: 3, pane: null, cwd: '/w', name: 'w', pid: 1, t, active: t, working: false });
	c.writeSession(rec('a', 100));
	c.writeSession(rec('b', 30));
	assert.equal(JSON.parse(readFileSync(join(dir, 'sessions/a.json'), 'utf-8')).id, 'a');
	c.pruneSessions(60);
	assert.deepEqual([existsSync(join(dir, 'sessions/a.json')), existsSync(join(dir, 'sessions/b.json'))], [true, false]);
	c.removeSession('a');
	assert.equal(existsSync(join(dir, 'sessions/a.json')), false);
});

test('a request names the session it is for', () => {
	const dir = temp();
	writeFileSync(join(dir, 'request.json'), JSON.stringify({ id: 'r1', path: '/w/a.ts', to: 's1' }));
	assert.deepEqual(new Channel(dir).request(), { id: 'r1', path: '/w/a.ts', to: 's1' });
});

test('when another session wrote the log, the next emit starts it again', () => {
	const dir = temp();
	let now = 1000;
	const one = new Channel(dir, () => now);
	const two = new Channel(dir, () => now);
	one.emit({ op: 'ready', call: 'c1' });
	now = 2000;
	two.emit({ op: 'ready', call: 'c2' });
	now = 3000;
	one.emit({ op: 'ready', call: 'c3' });
	const log = readFileSync(join(dir, 'events.jsonl'), 'utf-8');
	assert.deepEqual(log.trim().split('\n').map((l) => JSON.parse(l).call), ['c3']);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, 'head.json'), 'utf-8')), { gen: 3000, size: Buffer.byteLength(log) });
});

test('waitAck returns when the plugin acknowledges, or false after the timeout', async () => {
	const dir = temp();
	const c = new Channel(dir);
	assert.equal(await c.waitAck('c1', 60, 10), false);
	setTimeout(() => writeFileSync(join(dir, 'ack.json'), JSON.stringify(['c0', 'c1'])), 20);
	assert.equal(await c.waitAck('c1', 1000, 10), true);
});

test('install links the extension once and leaves a foreign path alone', () => {
	const ext = join(temp(), 'extensions');
	const first = planPiLink(ext, '/repo/pi');
	assert.equal(first.state, 'create');
	first.run?.();
	assert.equal(planPiLink(ext, '/repo/pi').state, 'ok');
	assert.equal(planPiLink(ext, '/other/pi').state, 'skip');
	const other = join(temp(), 'extensions');
	mkdirSync(other);
	symlinkSync('/somewhere', join(other, 'symbiosis'));
	assert.equal(planPiLink(other, '/repo/pi').state, 'skip');
});

test('install copies only changed plugin files and keeps runtime files', () => {
	const src = temp();
	writeFileSync(join(src, 'plugin.lua'), 'a');
	writeFileSync(join(src, 'plugin.ttt.json'), '{}');
	const dest = join(temp(), 'symbiosis');
	const first = planTttPlugin(dest, src);
	assert.equal(first.state, 'create');
	first.run?.();
	writeFileSync(join(dest, 'events.jsonl'), 'x');
	assert.equal(planTttPlugin(dest, src).state, 'ok');
	writeFileSync(join(src, 'plugin.lua'), 'b');
	const second = planTttPlugin(dest, src);
	assert.deepEqual([second.state, second.why], ['update', 'plugin.lua']);
	second.run?.();
	assert.equal(readFileSync(join(dest, 'events.jsonl'), 'utf-8'), 'x');
});
