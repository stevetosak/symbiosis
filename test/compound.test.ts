import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isLive, type RunState } from '../core/run/runs.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

type Out = { ok: boolean; error?: string; [k: string]: unknown };

interface Workspace {
	readonly ws: string;
	readonly runsDir: string;
	cli(...argv: string[]): Out;
	ps(): RunState[];
	until<T>(what: string, found: (runs: RunState[]) => T | undefined, ms?: number): Promise<T>;
	tail(id: string): string;
	done(): void;
}

function workspace(runJson: unknown, more: Record<string, string> = {}): Workspace {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'symbiosis-compound-')));
	const ws = join(dir, 'ws');
	const runsDir = join(dir, 'runs');
	mkdirSync(join(ws, '.symbiosis'), { recursive: true });
	writeFileSync(join(ws, '.symbiosis/run.json'), JSON.stringify(runJson));
	for (const [path, text] of Object.entries(more)) {
		mkdirSync(dirname(join(ws, path)), { recursive: true });
		writeFileSync(join(ws, path), text);
	}
	const env = { ...process.env, SYMBIOSIS_RUNS: runsDir };
	const cli = (...argv: string[]): Out => {
		const r = spawnSync(join(root, 'bin/symbiosis'), ['run', ...argv], { env, encoding: 'utf8', timeout: 20000 });
		assert.equal(r.stderr, '', r.stderr);
		return JSON.parse(r.stdout) as Out;
	};
	const ps = () => cli('ps', '--folder', ws).runs as RunState[];
	return {
		ws, runsDir, cli, ps,
		async until(what, found, ms = 10000) {
			const end = Date.now() + ms;
			for (;;) {
				const runs = ps();
				const got = found(runs);
				if (got !== undefined && got !== false) return got;
				if (Date.now() > end) assert.fail(`${what}: ${JSON.stringify(runs, null, 1)}`);
				await delay(100);
			}
		},
		tail: (id) => readFileSync(join(runsDir, id, 'tail.txt'), 'utf8'),
		done() {
			spawnSync(join(root, 'bin/symbiosis'), ['run', 'stop', '--folder', ws, '--all'], { env });
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function member(runs: RunState[], compound: string, name: string): RunState | undefined {
	return runs.filter((r) => r.compound === compound && r.name === name).at(-1);
}

test('compound: steps start in order; "finished" waits for all earlier steps to end, "started" for the step before to run', async () => {
	const w = workspace({
		configurations: [
			{ name: 'a', command: 'sleep 0.3; touch a.done' },
			{ name: 'b', command: 'sleep 0.6; touch b.done' },
			{ name: 'c', command: 'if [ -f a.done ] && [ -f b.done ]; then echo both done; fi; sleep 30' },
			{ name: 'd', command: 'sleep 30' },
		],
		compounds: [{
			name: 'All',
			steps: [{ run: 'a' }, { run: 'b' }, { run: 'c', after: 'finished' }, { run: 'd', after: 'started' }],
		}],
	});
	try {
		const started = w.cli('start', '--folder', w.ws, '--config', 'compound:All');
		assert.equal(started.ok, true, started.error);
		const cid = (started.run as RunState).id;
		assert.equal((started.run as RunState).configId, 'compound:All');

		const d = await w.until('d runs', (runs) => {
			const r = member(runs, cid, 'd');
			return r?.status === 'running' ? r : undefined;
		});
		const runs = w.ps();
		const [a, b, c] = ['a', 'b', 'c'].map((n) => member(runs, cid, n)!);
		assert.deepEqual([a.status, a.code, b.status, b.code], ['exited', 0, 'exited', 0]);
		assert.ok(c.started >= Math.max(a.ended!, b.ended!), 'c starts after a and b end');
		assert.ok(d.started >= c.started);
		await w.until('c says a and b are done', () => (/both done/.test(w.tail(c.id)) ? true : undefined));

		const compound = runs.find((r) => r.id === cid)!;
		assert.equal(compound.status, 'running');
		assert.deepEqual(compound.steps?.map((s) => s.name), ['a', 'b', 'c', 'd']);
		assert.equal(compound.next, 4);
		const log = w.tail(cid);
		assert.match(log, /c waits for a, b to finish/);
		assert.match(log, /d waits for c to start/);
		assert.match(log, /a starts[\s\S]*b starts[\s\S]*c starts[\s\S]*d starts/);
	} finally {
		w.done();
	}
});

test('compound: when every step ends without an error, the compound exits 0', async () => {
	const w = workspace({
		configurations: [{ name: 'a', command: 'true' }, { name: 'b', command: 'echo b' }],
		compounds: [{ name: 'Once', steps: [{ run: 'a' }, { run: 'b', after: 'finished' }] }],
	});
	try {
		const cid = (w.cli('start', '--folder', w.ws, '--config', 'compound:Once').run as RunState).id;
		const compound = await w.until('the compound ends', (runs) => runs.find((r) => r.id === cid && !isLive(r.status)));
		assert.deepEqual([compound.status, compound.code, compound.error], ['exited', 0, undefined]);
		assert.match(w.tail(cid), /all steps ended/);
	} finally {
		w.done();
	}
});

test('compound: one from .vscode/launch.json runs its launch configurations', async () => {
	const launch = (name: string) => ({ type: 'node-terminal', request: 'launch', name, command: 'sleep 30' });
	const w = workspace({ configurations: [] }, {
		'.vscode/launch.json': JSON.stringify({ configurations: [launch('server'), launch('client')], compounds: [{ name: 'Both', configurations: ['server', 'client'] }] }),
	});
	try {
		const cid = (w.cli('start', '--folder', w.ws, '--config', 'compound:vscode:Both').run as RunState).id;
		await w.until('server and client run', (runs) => ['server', 'client'].every((n) => member(runs, cid, n)?.status === 'running'));
	} finally {
		w.done();
	}
});

test('compound: run again or removed, its old steps go from the run list with it', async () => {
	const w = workspace({
		configurations: [{ name: 'a', command: 'true' }, { name: 'b', command: 'echo b' }],
		compounds: [{ name: 'Once', steps: [{ run: 'a' }, { run: 'b', after: 'finished' }] }],
	});
	const ended = (cid: string) => (runs: RunState[]) =>
		runs.some((r) => r.id === cid && !isLive(r.status)) && runs.filter((r) => r.compound === cid).length === 2;
	try {
		const first = (w.cli('start', '--folder', w.ws, '--config', 'compound:Once').run as RunState).id;
		await w.until('the compound ends', ended(first));
		const second = (w.cli('again', first).run as RunState).id;
		await w.until('it ends again', ended(second));
		assert.deepEqual(w.ps().filter((r) => r.id === first || r.compound === first), []);
		assert.deepEqual(w.cli('remove', second).removed, [second]);
		assert.deepEqual(w.ps(), []);
	} finally {
		w.done();
	}
});

test('compound: a step that exits with an error stops all; steps that wait do not start', async () => {
	const w = workspace({
		configurations: [
			{ name: 'svc', command: 'sleep 30' },
			{ name: 'setup', command: 'sleep 0.3; exit 1' },
			{ name: 'after-setup', command: 'echo too late' },
			{ name: 'crash', command: 'sleep 0.8; exit 7' },
		],
		compounds: [
			{ name: 'Early', steps: [{ run: 'svc' }, { run: 'setup' }, { run: 'after-setup', after: 'finished' }] },
			{ name: 'Late', steps: [{ run: 'svc' }, { run: 'crash', after: 'started' }] },
		],
	});
	try {
		const early = (w.cli('start', '--folder', w.ws, '--config', 'compound:Early').run as RunState).id;
		const e = await w.until('Early ends', (runs) => runs.find((r) => r.id === early && !isLive(r.status)));
		assert.deepEqual([e.status, e.error, e.next], ['failed', 'setup exited 1', 2]);
		const runs = w.ps();
		assert.equal(member(runs, early, 'svc')?.status, 'stopped');
		assert.equal(member(runs, early, 'after-setup'), undefined);
		assert.match(w.tail(early), /setup exited 1: stopping all/);

		const late = (w.cli('start', '--folder', w.ws, '--config', 'compound:Late').run as RunState).id;
		const l = await w.until('Late ends', (all) => all.find((r) => r.id === late && !isLive(r.status)));
		assert.deepEqual([l.status, l.error, l.next], ['failed', 'crash exited 7', 2]);
		assert.equal(member(w.ps(), late, 'svc')?.status, 'stopped');
	} finally {
		w.done();
	}
});

test('compound: a step the user stops or runs again is no error; the others go on', async () => {
	const w = workspace({
		configurations: [{ name: 'x', command: 'sleep 30' }, { name: 'y', command: 'sleep 30' }],
		compounds: [{ name: 'Pair', configurations: ['x', 'y'] }],
	});
	try {
		const cid = (w.cli('start', '--folder', w.ws, '--config', 'compound:Pair').run as RunState).id;
		const [x, y] = await w.until('x and y run', (runs) => {
			const both = [member(runs, cid, 'x'), member(runs, cid, 'y')];
			return both.every((r) => r?.status === 'running') ? (both as RunState[]) : undefined;
		});
		assert.equal((w.cli('stop', y.id).runs as RunState[])[0].status, 'stopped');
		const x2 = (w.cli('again', x.id).run as RunState).id;
		await delay(600);
		const runs = w.ps();
		assert.equal(runs.find((r) => r.id === cid)?.status, 'running');
		assert.deepEqual([member(runs, cid, 'x')?.id, member(runs, cid, 'x')?.status], [x2, 'running']);
		assert.doesNotMatch(w.tail(cid), /stopping all/);
	} finally {
		w.done();
	}
});

test('compound: stop stops every step, and a step that waits never starts', async () => {
	const w = workspace({
		configurations: [{ name: 'x', command: 'sleep 30' }, { name: 'z', command: 'echo z' }],
		compounds: [{ name: 'Wait', steps: [{ run: 'x' }, { run: 'z', after: 'finished' }] }],
	});
	try {
		const cid = (w.cli('start', '--folder', w.ws, '--config', 'compound:Wait').run as RunState).id;
		await w.until('x runs', (runs) => member(runs, cid, 'x')?.status === 'running');
		const began = Date.now();
		const stopped = (w.cli('stop', cid).runs as RunState[])[0];
		assert.ok(Date.now() - began < 4000, 'no wait for the stop timeout');
		assert.deepEqual([stopped.id, stopped.status], [cid, 'stopped']);
		await delay(400);
		const runs = w.ps();
		assert.equal(member(runs, cid, 'x')?.status, 'stopped');
		assert.equal(member(runs, cid, 'z'), undefined);
		assert.match(w.tail(cid), /stopped/);
	} finally {
		w.done();
	}
});

test('compound: starting it again restarts every step; another compound takes a shared step without an error', async () => {
	const w = workspace({
		configurations: [{ name: 'm', command: 'sleep 30' }, { name: 'p', command: 'sleep 30' }, { name: 'q', command: 'sleep 30' }],
		compounds: [{ name: 'One', configurations: ['m', 'p'] }, { name: 'Two', configurations: ['m', 'q'] }],
	});
	const running = (cid: string, names: string[]) => (runs: RunState[]) =>
		names.every((n) => member(runs, cid, n)?.status === 'running') ? true : undefined;
	try {
		const first = (w.cli('start', '--folder', w.ws, '--config', 'compound:One').run as RunState).id;
		await w.until('One runs', running(first, ['m', 'p']));
		const second = (w.cli('start', '--folder', w.ws, '--config', 'compound:One').run as RunState).id;
		let runs = w.ps();
		assert.equal(runs.find((r) => r.id === first)?.status, 'stopped');
		assert.deepEqual(['m', 'p'].map((n) => member(runs, first, n)?.status), ['stopped', 'stopped']);
		await w.until('One runs again', running(second, ['m', 'p']));

		const two = (w.cli('start', '--folder', w.ws, '--config', 'compound:Two').run as RunState).id;
		await w.until('Two runs', running(two, ['m', 'q']));
		await delay(400);
		runs = w.ps();
		assert.equal(member(runs, second, 'm')?.status, 'stopped');
		assert.deepEqual([runs.find((r) => r.id === second)?.status, member(runs, second, 'p')?.status], ['running', 'running']);
	} finally {
		w.done();
	}
});

test('compound: set input values go to their steps; one with no value is asked once; set ones are not remembered', async () => {
	const w = workspace({
		inputs: [
			{ id: 'profile', type: 'pick', options: ['nilan-local', 'ies-local'] },
			{ id: 'device', type: 'pick', options: ['d1', 'd2'] },
		],
		configurations: [
			{ name: 'api', command: 'echo "api ${input:profile} ${input:device}"' },
			{ name: 'web', command: 'echo "web ${input:profile} ${input:device}"' },
		],
		compounds: [{
			name: 'Env',
			inputs: { profile: 'nilan-local' },
			steps: [{ run: 'api' }, { run: 'web', inputs: { profile: 'ies-local' } }],
		}],
	});
	try {
		const asked = w.cli('start', '--folder', w.ws, '--config', 'compound:Env');
		assert.equal(asked.run, undefined);
		const ask = asked.ask as { config: string; name: string; input: { id: string } };
		assert.deepEqual([ask.config, ask.name, ask.input.id], ['compound:Env', 'Env', 'device']);

		const cid = (w.cli('start', '--folder', w.ws, '--config', 'compound:Env', '--input', 'device=d2').run as RunState).id;
		const runs = await w.until('Env ends', (all) => (all.some((r) => r.id === cid && !isLive(r.status)) ? all : undefined));
		assert.equal(w.tail(member(runs, cid, 'api')!.id), 'api nilan-local d2\n');
		assert.equal(w.tail(member(runs, cid, 'web')!.id), 'web ies-local d2\n');
		const memory = JSON.parse(readFileSync(join(dirname(w.runsDir), 'run-inputs.json'), 'utf8'));
		assert.deepEqual(Object.keys(memory[w.ws]), ['device']);
	} finally {
		w.done();
	}
});
