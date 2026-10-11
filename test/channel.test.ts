import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hasPackage, planOldLink, planTttPlugin } from '../install.ts';
import { syncTttPlugin } from '../pi/setup.ts';
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
	assert.deepEqual(c.plugin(), { alive: false, pinned: false, lag: 3 });
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, pinned: true }));
	assert.deepEqual(c.plugin(), { alive: true, pinned: true, lag: 3 });
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 6 }));
	assert.equal(c.plugin().alive, false);
});

test('the heartbeat names the owner: the session the editor follows', () => {
	const dir = temp();
	const c = new Channel(dir, () => 10_000);
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, owner: 's1' }));
	assert.deepEqual(c.plugin(), { alive: true, pinned: false, lag: 3, owner: 's1' });
});

test('the heartbeat says how far pi may run ahead; a bad value is the default', () => {
	const dir = temp();
	const c = new Channel(dir, () => 10_000);
	for (const [lag, want] of [[0, 0], [10, 10], [-1, -1], [-2, 3], [1.5, 3], ['x', 3]] as const) {
		writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, lag }));
		assert.equal(c.plugin().lag, want, String(lag));
	}
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

test('a helpi! request names the session it is for', () => {
	const dir = temp();
	assert.equal(new Channel(dir).help(), undefined);
	writeFileSync(join(dir, 'help.json'), JSON.stringify({ id: 'h1', to: 's1', path: '/w/a.ts', line: 3, question: '// why? helpi!', window: { first: 1, text: 'a\nb' } }));
	const r = new Channel(dir).help();
	assert.equal(r?.to, 's1');
	assert.equal(r?.line, 3);
	assert.equal(r?.cancel, false);
	assert.deepEqual(r?.window, { first: 1, text: 'a\nb' });
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

test('waitAck waits as long as it may, with no time limit', async () => {
	const dir = temp();
	const c = new Channel(dir);
	assert.equal(await c.waitAck('c1', () => false, 10), false);
	// A slow preview: the ack comes after 300 ms, and nothing cuts the wait short.
	setTimeout(() => writeFileSync(join(dir, 'ack.json'), JSON.stringify(['c0', 'c1'])), 300);
	assert.equal(await c.waitAck('c1', () => true, 10), true);
	// The wait ends when the caller says so: the plugin stopped, or the turn was aborted.
	let left = 3;
	assert.equal(await c.waitAck('c2', () => left-- > 0, 10), false);
});

test('pi waits only while more changes than the limit are not shown', async () => {
	const dir = temp();
	const c = new Channel(dir);
	writeFileSync(join(dir, 'ack.json'), JSON.stringify(['c1']));
	// c2..c4 not shown: with a limit of 3, no wait.
	assert.deepEqual(await c.waitBehind(['c1', 'c2', 'c3', 'c4'], 3, () => true, 10), ['c2', 'c3', 'c4']);
	// No limit: no wait, even far behind.
	assert.equal((await c.waitBehind(['a', 'b', 'c', 'd', 'e'], -1, () => true, 10)).length, 5);
	// A limit of 1 with c2, c3 not shown: the wait ends when the editor shows c2.
	setTimeout(() => writeFileSync(join(dir, 'ack.json'), JSON.stringify(['c1', 'c2'])), 200);
	const t = Date.now();
	assert.deepEqual(await c.waitBehind(['c2', 'c3'], 1, () => true, 10), ['c3']);
	assert.ok(Date.now() - t >= 150);
});

test('install removes only its own old link', () => {
	const ext = join(temp(), 'extensions');
	mkdirSync(ext);
	assert.equal(planOldLink(ext, '/repo').state, 'ok');
	symlinkSync('/repo/pi', join(ext, 'symbiosis'));
	const old = planOldLink(ext, '/repo');
	assert.equal(old.state, 'remove');
	old.run?.();
	assert.equal(planOldLink(ext, '/repo').state, 'ok');
	symlinkSync('/somewhere', join(ext, 'symbiosis'));
	assert.equal(planOldLink(ext, '/repo').state, 'skip');
});

test('install finds the pi package by path or GitHub URL', () => {
	assert.equal(hasPackage({ packages: ['npm:x', '/repo'] }, '/repo'), true);
	assert.equal(hasPackage({ packages: [{ source: 'git:github.com/stevetosak/symbiosis@v1' }] }, '/repo'), true);
	assert.equal(hasPackage({ packages: ['https://github.com/stevetosak/symbiosis'] }, '/repo'), true);
	assert.equal(hasPackage({ packages: ['npm:symbiosis-other'] }, '/repo'), false);
	assert.equal(hasPackage({}, '/repo'), false);
	// As pi writes it: relative to ~/.pi/agent.
	assert.equal(hasPackage({ packages: ['../../work/symbiosis'] }, '/home/u/work/symbiosis', '/home/u/.pi/agent'), true);
});

test('pi copies the plugin when it starts, only when ttt is there', () => {
	const src = temp();
	writeFileSync(join(src, 'plugin.lua'), 'a');
	const home = temp();
	assert.equal(syncTttPlugin({}, home, src), undefined);
	mkdirSync(join(home, '.config', 'ttt'), { recursive: true });
	assert.equal(syncTttPlugin({}, home, src)?.state, 'create');
	assert.equal(readFileSync(join(home, '.config', 'ttt', 'plugins', 'symbiosis', 'plugin.lua'), 'utf-8'), 'a');
	assert.equal(syncTttPlugin({}, home, src), undefined);
	writeFileSync(join(src, 'plugin.lua'), 'b');
	assert.equal(syncTttPlugin({}, home, src)?.state, 'update');
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
