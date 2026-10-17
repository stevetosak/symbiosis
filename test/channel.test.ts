import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hasPackage, planCommandLink, planOldLink, planTttPlugin } from '../install.ts';
import { syncTttPlugin } from '../pi/setup.ts';
import { FileChannel } from '../core/channel/file.ts';
import { paneOf } from '../core/session.ts';

const temp = () => mkdtempSync(join(tmpdir(), 'symbiosis-'));

test('without the plugin folder the channel writes nothing', () => {
	const dir = join(temp(), 'missing');
	const c = new FileChannel(dir);
	c.emit({ op: 'abort', call: 'c1' });
	assert.equal(c.enabled(), false);
});

test('events are appended and head.json tracks the size', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 1000);
	c.emit({ op: 'ready', call: 'c1' }, { op: 'abort', call: 'c2' });
	const log = readFileSync(join(dir, 'events.jsonl'), 'utf-8');
	assert.deepEqual(log.trim().split('\n').map((l) => JSON.parse(l).call), ['c1', 'c2']);
	assert.deepEqual(JSON.parse(readFileSync(join(dir, 'head.json'), 'utf-8')), { gen: 1000, size: Buffer.byteLength(log) });
});

test('the heartbeat says if ttt is alive and pinned', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 10_000);
	assert.deepEqual(c.plugin(), { alive: false, pinned: false, lag: 3, scope: 'stub' });
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, pinned: true }));
	assert.deepEqual(c.plugin(), { alive: true, pinned: true, lag: 3, scope: 'stub' });
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 6 }));
	assert.equal(c.plugin().alive, false);
});

test('the heartbeat names the owner: the session the editor follows', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 10_000);
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, owner: 's1' }));
	assert.deepEqual(c.plugin(), { alive: true, pinned: false, lag: 3, scope: 'stub', owner: 's1' });
});

test('the heartbeat says how far pi may run ahead; a bad value is the default', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 10_000);
	for (const [lag, want] of [[0, 0], [10, 10], [-1, -1], [-2, 3], [1.5, 3], ['x', 3]] as const) {
		writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, lag }));
		assert.equal(c.plugin().lag, want, String(lag));
	}
});

test('the heartbeat carries the scope; a bad value, or an editor that is gone, is stub', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 10_000);
	for (const [scope, want] of [['file', 'file'], ['off', 'off'], ['stub', 'stub'], ['all', 'stub'], [3, 'stub']] as const) {
		writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 9, scope }));
		assert.equal(c.plugin().scope, want, String(scope));
	}
	writeFileSync(join(dir, 'ttt.json'), JSON.stringify({ t: 1, scope: 'off' }));
	assert.equal(c.plugin().scope, 'stub', 'an old ttt.json');
});

test('fill requests and proposal answers are read; a bad one is none', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 10_000);
	assert.equal(c.fill(), undefined);
	writeFileSync(join(dir, 'fill.json'), JSON.stringify({ id: 'f1', to: 's1', path: '/w/a.ts', line: 3 }));
	assert.deepEqual(c.fill(), { id: 'f1', to: 's1', mode: 'stub', path: '/w/a.ts', line: 3, release: false }, 'no mode is a stub');
	writeFileSync(join(dir, 'fill.json'), JSON.stringify({ id: 'f4', to: 's1', mode: 'function', path: '/w/a.ts', line: 5 }));
	assert.deepEqual(c.fill(), { id: 'f4', to: 's1', mode: 'function', path: '/w/a.ts', line: 5, release: false });
	writeFileSync(join(dir, 'fill.json'), JSON.stringify({ id: 'f2', to: 's1', release: true }));
	assert.deepEqual(c.fill(), { id: 'f2', to: 's1', release: true });
	writeFileSync(join(dir, 'fill.json'), JSON.stringify({ id: 'f3', to: 's1', path: '/w/a.ts' }));
	assert.equal(c.fill(), undefined);
	writeFileSync(join(dir, 'answer.json'), JSON.stringify({ id: 'p1', accept: true, note: ' ok \n' }));
	assert.deepEqual(c.answer(), { id: 'p1', accept: true, note: 'ok' });
	writeFileSync(join(dir, 'answer.json'), JSON.stringify({ id: 'p1', accept: 'yes' }));
	assert.equal(c.answer(), undefined);
});

test('review acks are read; a bad one is none', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 10_000);
	assert.equal(c.review(), undefined);
	writeFileSync(join(dir, 'review.json'), JSON.stringify({ id: 'r1', to: 's1', ack: 'l1' }));
	assert.deepEqual(c.review(), { id: 'r1', to: 's1', ack: 'l1' });
	writeFileSync(join(dir, 'review.json'), JSON.stringify({ id: 'r1', to: 's1' }));
	assert.equal(c.review(), undefined);
});

test('session records are written, removed, and pruned when stale', () => {
	const dir = temp();
	const c = new FileChannel(dir, () => 100_000);
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
	assert.equal(new FileChannel(dir).help(), undefined);
	writeFileSync(join(dir, 'help.json'), JSON.stringify({ id: 'h1', to: 's1', path: '/w/a.ts', line: 3, question: '// why? helpi!', window: { first: 1, text: 'a\nb' } }));
	const r = new FileChannel(dir).help();
	assert.equal(r?.to, 's1');
	assert.equal(r?.line, 3);
	assert.equal(r?.cancel, false);
	assert.deepEqual(r?.window, { first: 1, text: 'a\nb' });
});

test('an ask request names the session, and carries the code and the answer before', () => {
	const dir = temp();
	assert.equal(new FileChannel(dir).ask(), undefined);
	writeFileSync(join(dir, 'ask.json'), JSON.stringify({ id: 'a1', to: 's1', path: '/w/a.ts', question: 'why?', target: { startLine: 2, endLine: 3, text: 'x\ny' }, parent: { question: 'q', answer: 'a' }, text: 'abc' }));
	const r = new FileChannel(dir).ask();
	assert.equal(r?.to, 's1');
	assert.deepEqual(r?.target, { startLine: 2, endLine: 3, text: 'x\ny' });
	assert.deepEqual(r?.parent, { question: 'q', answer: 'a' });
	assert.equal(r?.cancel, false);
});

test('when another session wrote the log, the next emit starts it again', () => {
	const dir = temp();
	let now = 1000;
	const one = new FileChannel(dir, () => now);
	const two = new FileChannel(dir, () => now);
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
	const c = new FileChannel(dir);
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
	const c = new FileChannel(dir);
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

test('install links the symbiosis command, and leaves a file there alone', () => {
	const bin = join(temp(), 'bin');
	const first = planCommandLink(bin, '/repo/bin/symbiosis');
	assert.equal(first.state, 'create');
	first.run?.();
	assert.equal(readlinkSync(join(bin, 'symbiosis')), '/repo/bin/symbiosis');
	assert.equal(planCommandLink(bin, '/repo/bin/symbiosis').state, 'ok');
	const moved = planCommandLink(bin, '/other/bin/symbiosis');
	assert.equal(moved.state, 'update');
	moved.run?.();
	assert.equal(readlinkSync(join(bin, 'symbiosis')), '/other/bin/symbiosis');
	const own = join(temp(), 'own');
	mkdirSync(own);
	writeFileSync(join(own, 'symbiosis'), '#!/bin/sh\n');
	assert.equal(planCommandLink(own, '/repo/bin/symbiosis').state, 'skip');
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

test('stop.json: the plugin asks one session to stop its turn', () => {
	const dir = temp();
	const c = new FileChannel(dir);
	assert.equal(c.stop(), undefined);
	writeFileSync(join(dir, 'stop.json'), JSON.stringify({ id: '17-1', to: 'p1' }));
	assert.deepEqual(c.stop(), { id: '17-1', to: 'p1' });
	writeFileSync(join(dir, 'stop.json'), JSON.stringify({ id: 3, to: 'p1' }));
	assert.equal(c.stop(), undefined);
});

test('the pane of pi: herdr, tmux, or none', () => {
	assert.deepEqual(paneOf({ HERDR_PANE_ID: 'w4:p1', TMUX: 'x', TMUX_PANE: '%1' }), { pane: 'w4:p1', host: 'herdr' });
	assert.deepEqual(paneOf({ TMUX: '/tmp/t,1,0', TMUX_PANE: '%3' }), { pane: '%3', host: 'tmux' });
	assert.deepEqual(paneOf({ TMUX_PANE: '%3' }), { pane: null, host: null });
});
