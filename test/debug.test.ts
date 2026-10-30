import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ADAPTER_TYPES, adapterFor, DebugSetupError, type Probe } from '../core/debug/adapters.ts';
import { DapClient, Framer, frame } from '../core/debug/dap.ts';
import { DebugSession, MAX_WATCHES, SEP } from '../core/debug/session.ts';
import { DEBUG_TYPES, type DebugSpec, debugSpecOf, hasAdapter, inferDebug, isCompiled, plainWords, resolveDebug, specOf } from '../core/debug/spec.ts';
import { type DebugView, parseBreakpoints, parseCommands } from '../core/debug/view.ts';
import { parseRunJson, RunConfigError, toRunJson } from '../core/run/config.ts';
import { listed, resolveConfig } from '../core/run/list.ts';
import { importLaunch } from '../core/run/vscode.ts';
import { LineJoiner } from '../launcher/debug.ts';
import { FakeAdapter } from './fixtures/fake-dap.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = join(root, 'test', 'fixtures', 'fake-dap.ts');

function temp(): string {
	return realpathSync(mkdtempSync(join(tmpdir(), 'symbiosis-debug-')));
}

async function until<T>(what: string, get: () => T | undefined | false, ms = 5000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const v = get();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await delay(15);
	}
}

// The wire -------------------------------------------------------------------------

test('Framer: messages cut anywhere, two in one chunk, a header with no length', () => {
	const got: string[] = [];
	const f = new Framer((t) => got.push(t));
	const a = frame({ a: 'é' });
	const b = frame({ b: 2 });
	const all = Buffer.from(`X-Other: 1\r\n\r\n${a}${b}`);
	for (let i = 0; i < all.length; i += 3) f.push(all.subarray(i, i + 3));
	assert.deepEqual(got.map((t) => JSON.parse(t)), [{ a: 'é' }, { b: 2 }]);
	assert.match(a, /^Content-Length: 10\r\n\r\n/, 'the length counts bytes, not characters');
});

function pair(): { client: DapClient; adapter: FakeAdapter } {
	const toAdapter = new PassThrough();
	const toClient = new PassThrough();
	return { adapter: new FakeAdapter(toAdapter, toClient), client: new DapClient(toAdapter, toClient) };
}

test('DapClient: a request and its answer, a failed one, events, an unknown reverse request, close', async () => {
	const { client } = pair();
	const caps = await client.request('initialize', { adapterID: 'fake' });
	assert.equal(caps.supportsConfigurationDoneRequest, true);
	await assert.rejects(client.request('bogus'), /fake-dap: no bogus/);
	const toAdapter = new PassThrough();
	const toClient = new PassThrough();
	const c = new DapClient(toAdapter, toClient);
	const events: string[] = [];
	c.on('output', (b) => events.push(b.output));
	toClient.write(frame({ seq: 1, type: 'event', event: 'output', body: { output: 'hi' } }));
	const answers: any[] = [];
	new Framer((t) => answers.push(JSON.parse(t))).push(Buffer.from(''));
	toAdapter.on('data', (d: Buffer) => new Framer((t) => answers.push(JSON.parse(t))).push(d));
	toClient.write(frame({ seq: 2, type: 'request', command: 'runInTerminal', arguments: {} }));
	c.handle('startDebugging', () => ({}));
	toClient.write(frame({ seq: 3, type: 'request', command: 'startDebugging', arguments: {} }));
	await until('answers', () => answers.length >= 2);
	assert.deepEqual(events, ['hi']);
	assert.deepEqual(answers.map((a) => [a.request_seq, a.success]), [[2, false], [3, true]]);
	const pending = c.request('never');
	c.close('gone');
	await assert.rejects(pending, /gone/);
	await assert.rejects(c.request('after'), /gone/);
	await assert.rejects(c.once('stopped', 1000), /gone/);
});

// What can be debugged -----------------------------------------------------------------

test('inferDebug: python, node, go, a compiled program; not -c, -e, uv run, a shell line', () => {
	assert.deepEqual(inferDebug('python3', ['app.py', '--port', '1']), { type: 'python', request: 'launch', python: 'python3', program: 'app.py', args: ['--port', '1'] });
	assert.deepEqual(inferDebug('.venv/bin/python', ['-u', '-X', 'dev', '-m', 'pytest', '-x']), {
		type: 'python', request: 'launch', python: '.venv/bin/python', module: 'pytest', args: ['-x'], pythonArgs: ['-u', '-X', 'dev'],
	});
	assert.deepEqual(inferDebug('python3 manage.py runserver', undefined)?.program, 'manage.py', 'a shell line of plain words');
	assert.equal(inferDebug('python3', ['-c', 'print(1)']), undefined);
	assert.equal(inferDebug('uv run python x.py', undefined), undefined);
	assert.equal(inferDebug('python3 a.py | tee log', undefined), undefined, 'a pipe: not plain words');
	assert.deepEqual(inferDebug('node', ['--enable-source-maps', 'x.js', 'a']), {
		type: 'node', request: 'launch', program: 'x.js', args: ['a'], runtimeArgs: ['--enable-source-maps'],
	});
	assert.equal(inferDebug('node', ['-e', 'x']), undefined);
	assert.equal(inferDebug('node', ['--test']), undefined);
	assert.deepEqual(inferDebug('go', ['run', '-race', './cmd/api', '-v']), { type: 'go', request: 'launch', mode: 'debug', program: './cmd/api', args: ['-v'], buildFlags: '-race' });
	assert.deepEqual(inferDebug('env PORT=1 python3 a.py', undefined), { type: 'python', request: 'launch', python: 'python3', program: 'a.py', args: [], env: { PORT: '1' } });
	assert.deepEqual(inferDebug('./build/app', ['x'], (p) => p === './build/app'), { type: 'lldb', request: 'launch', program: './build/app', args: ['x'] });
	assert.equal(inferDebug('./run.sh', [], () => false), undefined, 'a script is not a compiled program');
	assert.equal(inferDebug('make', ['build']), undefined);
	assert.deepEqual(plainWords(' a  b/c.d '), ['a', 'b/c.d']);
	assert.equal(plainWords('a "b"'), undefined);
});

test('isCompiled: Mach-O and ELF, not a script', () => {
	const dir = temp();
	try {
		writeFileSync(join(dir, 'elf'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]));
		writeFileSync(join(dir, 'macho'), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0]));
		writeFileSync(join(dir, 'sh'), '#!/bin/sh\necho\n');
		assert.equal(isCompiled(join(dir, 'elf')), true);
		assert.equal(isCompiled(join(dir, 'macho')), true);
		assert.equal(isCompiled(join(dir, 'sh')), false);
		assert.equal(isCompiled(join(dir, 'none')), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('specOf: VS Code\'s own keys out; a type is needed; only launch', () => {
	assert.deepEqual(specOf({ name: 'x', type: 'python', request: 'launch', program: 'a.py', preLaunchTask: 'b', presentation: {} }, 'at'), { type: 'python', request: 'launch', program: 'a.py' });
	assert.deepEqual(specOf({ type: 'go' }, 'at'), { type: 'go', request: 'launch' });
	assert.throws(() => specOf({ program: 'a' }, 'run.json: x.debug'), /run.json: x.debug needs a "type"/);
	assert.throws(() => specOf({ type: 'python', request: 'attach' }, 'at'), /"request" must be "launch"/);
	assert.throws(() => specOf('python' as never, 'at'), /must be an object/);
});

test('run.json "debug", launch.json\'s configuration, the listed type, Save keeps it', () => {
	const { configs } = parseRunJson(JSON.stringify({ configurations: [
		{ name: 'api', command: 'npm run dev', debug: { type: 'node', program: '${workspaceFolder}/server.js' } },
		{ name: 'plain', command: 'make' },
	] }));
	assert.deepEqual(configs[0].debug, { type: 'node', request: 'launch', program: '${workspaceFolder}/server.js' });
	assert.deepEqual(toRunJson(configs[0]).debug, configs[0].debug);
	assert.throws(() => parseRunJson(JSON.stringify({ configurations: [{ name: 'x', command: 'y', debug: { program: 'a' } }] })), /configurations\[0\].debug needs a "type"/);
	const launch = importLaunch(JSON.stringify({ configurations: [
		{ name: 'py', type: 'debugpy', request: 'launch', program: '${file}', justMyCode: false, console: 'integratedTerminal' },
	] }));
	assert.deepEqual(launch.configs[0].debug, { type: 'debugpy', request: 'launch', program: '${file}', justMyCode: false, console: 'integratedTerminal' });
	assert.equal(listed('/w', configs[0]).debug, 'node');
	assert.equal(listed('/w', configs[1]).debug, undefined);
	assert.equal(listed('/w', { id: 'file', name: 'Current file', group: 'Current file', command: '' }, '/w/a.py').debug, 'python');
	assert.equal(debugSpecOf(configs[1], { folder: '/w' }), undefined);
});

test('resolveDebug: variables, cwd and env from the launch, the program absolute, the python in cwd', () => {
	const dir = temp();
	try {
		mkdirSync(join(dir, 'api'));
		const config = { id: 'saved:x', name: 'x', group: 'Saved', command: 'python3', args: ['app.py'], cwd: 'api', env: { A: '1', B: '${workspaceFolderBasename}' } };
		const ctx = { folder: dir, file: join(dir, 'api', 'app.py'), env: {} };
		const launch = resolveConfig(config, ctx);
		const spec = resolveDebug({ type: 'python', request: 'launch', program: 'app.py', python: '.venv/bin/python', env: { B: 'own', C: '${fileBasename}' }, args: ['${relativeFile}'] }, launch, ctx);
		assert.equal(spec.cwd, join(dir, 'api'));
		assert.equal(spec.program, join(dir, 'api', 'app.py'));
		assert.equal(spec.python, join(dir, 'api', '.venv', 'bin', 'python'));
		assert.deepEqual(spec.env, { A: '1', B: 'own', C: 'app.py' });
		assert.deepEqual(spec.args, ['api/app.py']);
		const go = resolveDebug({ type: 'go', request: 'launch', program: './cmd/api' }, launch, ctx);
		assert.equal(go.program, './cmd/api', 'go takes a package against cwd');
		assert.throws(() => resolveDebug({ type: 'python', request: 'launch', program: '${command:pickFile}' }, launch, ctx), RunConfigError);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The adapters -------------------------------------------------------------------------

function probe(over: Partial<Probe> & { has?: Record<string, boolean>; files?: string[]; dirs?: Record<string, string[]> } = {}): Probe {
	const files = new Set(over.files ?? []);
	return {
		which: (c) => (c.includes('/') ? (files.has(c) ? c : undefined) : files.has(`/bin/${c}`) ? `/bin/${c}` : undefined),
		ok: (c, args, env) => Boolean(over.has?.[`${c}${env?.PYTHONPATH ? `+${env.PYTHONPATH.split(':')[0]}` : ''}`]),
		out: () => undefined,
		exists: (p) => files.has(p) || Object.keys(over.dirs ?? {}).some((d) => p.startsWith(`${d}/`) && (over.dirs![d].some((n) => p === `${d}/${n}` || p.startsWith(`${d}/${n}/`)))),
		list: (d) => over.dirs?.[d] ?? [],
		home: '/h',
		env: {},
		platform: 'linux',
		...over,
	};
}

const py: DebugSpec = { type: 'python', request: 'launch', program: '/w/a.py', python: 'python3', cwd: '/w', env: { A: '1' } };

test('adapterFor python: debugpy in the program\'s python; else VS Code\'s copy; else how to install it', () => {
	const own = adapterFor(py, probe({ files: ['/bin/python3'], has: { '/bin/python3': true } }));
	assert.deepEqual([own.command, own.args, own.env, own.transport], ['/bin/python3', ['-m', 'debugpy.adapter'], {}, { kind: 'stdio' }]);
	assert.equal(own.launch.console, 'internalConsole');
	assert.equal(own.launch.justMyCode, true);
	assert.equal(own.launch.python, '/bin/python3');
	const ext = '/h/.vscode/extensions';
	const libs = `${ext}/ms-python.debugpy-2026.6.0-darwin-arm64/bundled/libs`;
	const vs = adapterFor(py, probe({
		files: ['/bin/python3', `${libs}/debugpy`],
		dirs: { [ext]: ['ms-python.debugpy-2025.1.0', 'ms-python.debugpy-2026.6.0-darwin-arm64'] },
		has: { [`/bin/python3+${libs}`]: true },
	}));
	assert.equal(vs.env.PYTHONPATH, libs, 'the newest copy');
	assert.match(vs.label, /from ~\/.vscode/);
	assert.throws(() => adapterFor(py, probe({ files: ['/bin/python3'] })), /debugpy is not installed for python3; install it: python3 -m pip install debugpy/);
	assert.throws(() => adapterFor(py, probe()), /python: python3 is not there/);
});

test('adapterFor lldb, go, node, a spec\'s own adapter; an unknown type', () => {
	const c: DebugSpec = { type: 'cppdbg', request: 'launch', program: '/w/app', args: ['x'], cwd: '/w', environment: [{ name: 'A', value: '1' }], MIMode: 'gdb' };
	const lldb = adapterFor(c, probe({ files: ['/bin/lldb-dap'] }));
	assert.equal(lldb.command, '/bin/lldb-dap');
	assert.deepEqual(lldb.launch.env, ['A=1']);
	assert.equal(lldb.launch.MIMode, undefined);
	const mac = adapterFor({ ...c, type: 'lldb' }, probe({ platform: 'darwin', out: (cmd, args) => (cmd === 'xcrun' && args[1] === 'lldb-dap' ? '/x/lldb-dap' : undefined) }));
	assert.equal(mac.command, '/x/lldb-dap', 'Xcode\'s');
	assert.throws(() => adapterFor(c, probe()), /lldb-dap is not there/);
	assert.throws(() => adapterFor({ type: 'lldb', request: 'launch' }, probe({ files: ['/bin/lldb-dap'] })), /needs a "program"/);

	const go = adapterFor({ type: 'go', request: 'launch', program: '.' }, probe({ files: ['/h/go/bin/dlv'] }));
	assert.deepEqual([go.command, go.args, go.transport.kind, go.launch.mode], ['/h/go/bin/dlv', ['dap', '--listen=127.0.0.1:0'], 'tcp', 'debug']);
	assert.match('DAP server listening at: 127.0.0.1:51234', new RegExp((go.transport as { pattern: string }).pattern));
	assert.throws(() => adapterFor({ type: 'go', request: 'launch' }, probe()), /go install github.com\/go-delve/);

	const js = adapterFor({ type: 'node', request: 'launch', program: 'x.js' }, probe({ env: { SYMBIOSIS_JS_DEBUG: '/j' }, files: ['/j/src/dapDebugServer.js'] }));
	assert.deepEqual(js.args, ['/j/src/dapDebugServer.js', '0', '127.0.0.1']);
	assert.equal(js.launch.type, 'pwa-node');
	assert.equal(new RegExp((js.transport as { pattern: string }).pattern).exec('Debug server listening at 127.0.0.1:50516')?.[1], '50516');
	assert.throws(() => adapterFor({ type: 'node', request: 'launch' }, probe()), /js-debug-dap/);

	const own = adapterFor({ type: 'ruby', request: 'launch', adapter: ['rdbg-dap', '--stdio'], script: 'a.rb' }, probe({ files: ['/bin/rdbg-dap'] }));
	assert.deepEqual([own.command, own.args, own.launch.adapter, own.launch.script, own.transport.kind], ['/bin/rdbg-dap', ['--stdio'], undefined, 'a.rb', 'stdio']);
	assert.equal(adapterFor({ type: 'x', request: 'launch', adapter: { command: '/a/x', args: ['1'], port: true } }, probe({ files: ['/a/x'] })).transport.kind, 'tcp');
	assert.throws(() => adapterFor({ type: 'x', request: 'launch', adapter: [] }, probe()), /"adapter" must be a command/);
	assert.throws(() => adapterFor({ type: 'cobol', request: 'launch' }, probe()), (e) => e instanceof DebugSetupError && /no debugger for type "cobol"/.test(e.message));
	assert.deepEqual([...ADAPTER_TYPES].sort(), [...DEBUG_TYPES].sort(), 'spec.ts and adapters.ts know the same types');
	assert.equal(hasAdapter({ type: 'coreclr', request: 'launch' }), false);
	assert.equal(hasAdapter({ type: 'coreclr', request: 'launch', adapter: ['netcoredbg', '--interpreter=vscode'] }), true);
});

// The files between the plugin and the supervisor ---------------------------------------

test('parseBreakpoints and parseCommands: what is not one is skipped', () => {
	const bps = parseBreakpoints({ files: { '/a.py': [{ line: 3 }, { line: 0 }, { line: 2.5 }, { line: 7, condition: 'x > 1', hash: 9 }], 'rel.py': [{ line: 1 }], '/b.py': [] } });
	assert.deepEqual([...bps], [['/a.py', [{ line: 3 }, { line: 7, condition: 'x > 1' }]]]);
	assert.equal(parseBreakpoints(undefined).size, 0);
	assert.equal(parseBreakpoints({ files: [] }).size, 0, 'Lua writes an empty table as a list');
	assert.deepEqual(parseCommands({ cmds: [{ seq: 2, op: 'next' }, { op: 'x' }, { seq: 1, op: 'continue' }] }).map((c) => c.seq), [1, 2]);
	assert.deepEqual(parseCommands(null), []);
});

test('LineJoiner: whole lines; stdout and stderr do not cut into each other; a partial line comes after a pause', async () => {
	const out: string[] = [];
	const j = new LineJoiner((t) => out.push(t));
	j.push('stdout', 'sum');
	j.push('stderr', 'warn\n');
	j.push('stdout', ' 6\nnext');
	assert.deepEqual(out, ['warn\n', 'sum 6\n']);
	await delay(200);
	assert.deepEqual(out, ['warn\n', 'sum 6\n', 'next']);
	j.push('stdout', 'a');
	j.flush();
	assert.equal(out.at(-1), 'a');
});

// The session -----------------------------------------------------------------------------

function program(lines: string[]): { dir: string; path: string } {
	const dir = temp();
	const path = join(dir, 'prog.txt');
	writeFileSync(path, `${lines.join('\n')}\n`);
	return { dir, path };
}

function fakeStart(launch: Record<string, unknown>) {
	return { command: '', args: [], env: {}, cwd: '/', transport: { kind: 'stdio' as const }, adapterID: 'fake', launch: { type: 'fake', request: 'launch', ...launch }, label: 'fake' };
}

test('DebugSession: a breakpoint, the stack, scopes, expand, a watch, a step, a frame, collapse, breakpoints off, the end', async () => {
	const { dir, path } = program(['x = 1', 'print hello', 'y = 2', 'z = 3', 'print bye']);
	try {
		const { client, adapter } = pair();
		const views: DebugView[] = [];
		const out: string[] = [];
		const s = new DebugSession(fakeStart({ program: path }), new Map([[path, [{ line: 3 }]]]), {
			reconnects: false, connect: async () => client, onView: (v) => views.push(v), onOutput: (_c, t) => out.push(t),
		});
		await s.start();
		const last = () => views.at(-1)!;
		await until('paused', () => last().status === 'paused' && last().vars.Locals);
		let v = last();
		assert.deepEqual(v.stop, { reason: 'breakpoint', threadId: 1 });
		assert.deepEqual(v.frames.map((f) => [f.name, f.line, f.hint]), [['main', 3, undefined], ['lib', 7, 'subtle']]);
		assert.equal(v.frame, 0);
		assert.deepEqual(v.scopes.map((x) => x.key), ['Locals', 'Globals']);
		assert.deepEqual(v.expanded, ['Locals'], 'the first scope is open');
		assert.deepEqual(v.vars.Locals.map((x) => [x.name, x.value, x.ref > 0]), [['line', '3', false], ['list', '[1, 2]', true]]);
		assert.equal(v.vars.Globals, undefined);
		assert.deepEqual(v.breakpoints[path], [{ line: 3, verified: true }]);
		assert.equal(out.join(''), 'hello\n');
		const filters = adapter.got.find((m) => m.command === 'setExceptionBreakpoints');
		assert.deepEqual(filters?.arguments, { filters: ['uncaught'] }, 'the filters on by default');

		await s.command({ seq: 1, op: 'expand', key: `Locals${SEP}list` });
		await s.command({ seq: 2, op: 'evaluate', expr: 'line * 10' });
		v = last();
		assert.deepEqual(v.vars[`Locals${SEP}list`].map((x) => x.value), ['1', '2']);
		assert.deepEqual(v.evals.map((e) => [e.expr, e.value]), [['line * 10', '30']]);
		assert.equal(v.ack, 2);

		await s.command({ seq: 3, op: 'next' });
		await until('stepped', () => last().stop?.reason === 'step' && last().vars[`Locals${SEP}list`]);
		v = last();
		assert.equal(v.frames[0].line, 4);
		assert.equal(v.evals[0].value, '40', 'a watch is evaluated again at each stop');
		assert.deepEqual(v.vars[`Locals${SEP}list`].map((x) => x.value), ['1', '2'], 'what was open is open again');

		await s.command({ seq: 4, op: 'frame', index: 1 });
		assert.equal(last().frame, 1);
		await s.command({ seq: 5, op: 'collapse', key: 'Locals' });
		assert.deepEqual(last().expanded, []);
		await s.command({ seq: 6, op: 'next' });
		await until('stepped again', () => last().frames[0]?.line === 5);
		assert.deepEqual(last().expanded, [], 'a scope you closed stays closed');
		assert.equal(last().frame, 0, 'a new stop chooses the first frame again');

		await s.command({ seq: 7, op: 'breakpoints', path, lines: [] });
		assert.deepEqual(adapter.got.filter((m) => m.command === 'setBreakpoints').at(-1)?.arguments.breakpoints, []);
		assert.equal(last().breakpoints[path], undefined);
		await s.command({ seq: 8, op: 'unwatch', expr: 'line * 10' });
		assert.deepEqual(last().evals, []);

		await s.command({ seq: 9, op: 'continue' });
		assert.equal(await s.ended, 0);
		assert.equal(last().status, 'ended');
		assert.equal(s.endedBy, 'terminated');
		assert.equal(out.join(''), 'hello\nbye\n');
		await s.command({ seq: 10, op: 'next' });
		assert.match(last().error ?? '', /next: the program is not paused/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('DebugSession: a launch that fails says why; watches are kept to MAX_WATCHES', async () => {
	const { client } = pair();
	const s = new DebugSession(fakeStart({ program: '/no/such' }), new Map(), { reconnects: false, connect: async () => client, onView: () => {}, onOutput: () => {} });
	await assert.rejects(s.start(), /launch failed: no such program: \/no\/such/);

	const { dir, path } = program(['a', 'b']);
	try {
		const p = pair();
		const views: DebugView[] = [];
		const t = new DebugSession(fakeStart({ program: path, stopOnEntry: true }), new Map(), { reconnects: false, connect: async () => p.client, onView: (v) => views.push(v), onOutput: () => {} });
		await t.start();
		await until('entry', () => views.at(-1)?.stop?.reason === 'entry' && views.at(-1)!.frames.length > 0);
		for (let i = 0; i < MAX_WATCHES + 2; i++) await t.command({ seq: i + 1, op: 'evaluate', expr: `e${i}` });
		const evals = views.at(-1)!.evals;
		assert.equal(evals.length, MAX_WATCHES);
		assert.equal(evals[0].expr, `e${MAX_WATCHES + 1}`, 'the newest first');
		assert.equal(evals[0].error, true);
		await t.terminate();
		assert.equal(views.at(-1)!.status, 'ended');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('DebugSession: a child session (startDebugging) runs the program, its stop is the one shown', async () => {
	const { dir, path } = program(['a', 'b', 'print c']);
	try {
		const rootPair = pair();
		const children: FakeAdapter[] = [];
		const views: DebugView[] = [];
		const out: string[] = [];
		let n = 0;
		const s = new DebugSession(fakeStart({ program: path, child: true }), new Map([[path, [{ line: 2 }]]]), {
			reconnects: true,
			async connect() {
				if (n++ === 0) return rootPair.client;
				const p = pair();
				p.adapter.onFinish = () => rootPair.adapter.terminate();
				children.push(p.adapter);
				return p.client;
			},
			onView: (v) => views.push(v),
			onOutput: (_c, t) => out.push(t),
		});
		await s.start();
		await until('paused in the child', () => views.at(-1)?.status === 'paused' && views.at(-1)!.frames.length > 0);
		assert.equal(children.length, 1);
		assert.equal(views.at(-1)!.frames[0].line, 2);
		assert.deepEqual(views.at(-1)!.breakpoints[path], [{ line: 2, verified: true }]);
		await s.command({ seq: 1, op: 'continue' });
		await s.ended;
		assert.equal(out.join(''), 'c\n');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// The supervisor, through `symbiosis run` --------------------------------------------------

type Out = { ok: boolean; error?: string; [k: string]: any };

test('symbiosis run start --debug: the supervisor, debug.json, the commands, the output, stop', async () => {
	const dir = temp();
	const ws = join(dir, 'ws');
	const plugin = join(dir, 'plugin');
	const runsDir = join(plugin, 'runs');
	mkdirSync(join(ws, '.symbiosis'), { recursive: true });
	mkdirSync(runsDir, { recursive: true });
	const prog = join(ws, 'prog.txt');
	writeFileSync(prog, 'a\nprint one\nb\nprint two\nfail\n');
	writeFileSync(join(ws, '.symbiosis', 'run.json'), JSON.stringify({ configurations: [
		{ name: 'fake', command: 'fake prog.txt', debug: { type: 'fake', adapter: [process.execPath, FAKE], program: '${workspaceFolder}/prog.txt' } },
		{ name: 'plain', command: 'make' },
		{ name: 'gone', command: 'x', debug: { type: 'fake', adapter: ['/no/adapter'] } },
	] }));
	writeFileSync(join(plugin, 'breakpoints.json'), JSON.stringify({ files: { [prog]: [{ line: 3, hash: 1 }] } }));
	const cli = (...argv: string[]): Out => {
		const r = spawnSync(join(root, 'bin/symbiosis'), ['run', ...argv, '--runs', runsDir], { encoding: 'utf8', timeout: 20000 });
		return JSON.parse(r.stdout);
	};
	try {
		const list = cli('list', '--folder', ws);
		assert.deepEqual(list.configs.map((c: any) => [c.name, c.debug]), [['fake', 'fake'], ['plain', undefined], ['gone', 'fake']]);
		assert.match(cli('start', '--folder', ws, '--config', 'saved:plain', '--debug').error, /does not know how to debug "plain"/);
		assert.match(cli('start', '--folder', ws, '--config', 'saved:gone', '--debug').error, /the adapter \/no\/adapter is not there/);

		const started = cli('start', '--folder', ws, '--config', 'saved:fake', '--debug');
		assert.equal(started.ok, true, started.error);
		assert.equal(started.run.debug, 'fake');
		const id = started.run.id;
		const file = (name: string) => join(runsDir, id, name);
		const view = (): DebugView | undefined => (existsSync(file('debug.json')) ? JSON.parse(readFileSync(file('debug.json'), 'utf8')) : undefined);
		const state = () => JSON.parse(readFileSync(file('state.json'), 'utf8'));
		await until('paused', () => view()?.status === 'paused' && view()!.frames.length > 0, 10000);
		assert.deepEqual(state().paused, { reason: 'breakpoint', path: prog, line: 3 });
		assert.equal(state().status, 'running');
		writeFileSync(file('debug-in.json'), JSON.stringify({ cmds: [{ seq: 1, op: 'next' }] }));
		await until('stepped', () => view()?.ack === 1 && view()?.frames[0]?.line === 4, 5000);
		// The plugin keeps a command until it is acked: one done is not done again.
		writeFileSync(file('debug-in.json'), JSON.stringify({ cmds: [{ seq: 1, op: 'next' }, { seq: 2, op: 'evaluate', expr: 'line * 10' }] }));
		await until('watched', () => view()?.ack === 2, 5000);
		assert.equal(view()!.frames[0].line, 4);
		assert.equal(view()!.evals[0].value, '40');
		writeFileSync(file('debug-in.json'), JSON.stringify({ cmds: [{ seq: 3, op: 'continue' }] }));
		await until('ended', () => state().status === 'exited', 8000);
		assert.equal(state().code, 1, 'the program\'s exit code');
		assert.equal(state().paused, undefined);
		const tail = readFileSync(file('tail.txt'), 'utf8');
		assert.match(tail, /▶ debugging fake with /);
		assert.match(tail, /\none\ntwo\n/, 'whole lines, though the adapter cut each write in two');
		assert.match(tail, /the program exited 1/);
		assert.match(readFileSync(file('dap.log'), 'utf8'), /"command":"setBreakpoints"/);

		// Stop: the session ends itself (a disconnect), the run is stopped.
		writeFileSync(prog, 'a\nb\nc\nd\n');
		const again = cli('start', '--folder', ws, '--config', 'saved:fake', '--debug');
		const id2 = again.run.id;
		await until('paused again', () => existsSync(join(runsDir, id2, 'debug.json')) && JSON.parse(readFileSync(join(runsDir, id2, 'debug.json'), 'utf8')).status === 'paused', 10000);
		const stopped = cli('stop', id2);
		assert.equal(stopped.runs[0].status, 'stopped');
		const s2 = JSON.parse(readFileSync(join(runsDir, id2, 'state.json'), 'utf8'));
		assert.equal(s2.status, 'stopped');
	} finally {
		spawnSync(join(root, 'bin/symbiosis'), ['run', 'stop', '--folder', ws, '--all', '--runs', runsDir]);
		rmSync(dir, { recursive: true, force: true });
	}
});

// Real debuggers, when this machine has them ----------------------------------------------

const lldbDap = process.platform === 'darwin'
	? spawnSync('xcrun', ['-f', 'lldb-dap'], { encoding: 'utf8' }).stdout?.trim()
	: spawnSync('sh', ['-c', 'command -v lldb-dap'], { encoding: 'utf8' }).stdout?.trim();
const cc = spawnSync('sh', ['-c', 'command -v cc'], { encoding: 'utf8' }).stdout?.trim();

test('lldb-dap: a C program pauses at a breakpoint, shows its locals, exits with its code', { skip: !lldbDap || !cc ? 'no lldb-dap or cc' : false }, async () => {
	const dir = temp();
	const ws = join(dir, 'ws');
	const runsDir = join(dir, 'plugin', 'runs');
	mkdirSync(ws, { recursive: true });
	mkdirSync(runsDir, { recursive: true });
	const src = join(ws, 'sq.c');
	writeFileSync(src, '#include <stdio.h>\nint square(int x) {\n    int y = x * x;\n    return y;\n}\nint main(void) {\n    printf("%d\\n", square(7));\n    return 3;\n}\n');
	spawnSync('cc', ['-g', '-O0', '-o', join(ws, 'sq'), src], { cwd: ws });
	chmodSync(join(ws, 'sq'), 0o755);
	writeFileSync(join(dir, 'plugin', 'breakpoints.json'), JSON.stringify({ files: { [src]: [{ line: 4 }] } }));
	mkdirSync(join(ws, '.symbiosis'));
	writeFileSync(join(ws, '.symbiosis', 'run.json'), JSON.stringify({ configurations: [{ name: 'sq', command: './sq' }] }));
	const cli = (...argv: string[]): Out => JSON.parse(spawnSync(join(root, 'bin/symbiosis'), ['run', ...argv, '--runs', runsDir], { encoding: 'utf8', timeout: 20000 }).stdout);
	try {
		assert.equal(cli('list', '--folder', ws).configs[0].debug, 'lldb', 'a compiled program: lldb');
		const started = cli('start', '--folder', ws, '--config', 'saved:sq', '--debug');
		assert.ok(started.ok, started.error);
		const file = (name: string) => join(runsDir, started.run.id, name);
		const view = (): DebugView | undefined => (existsSync(file('debug.json')) ? JSON.parse(readFileSync(file('debug.json'), 'utf8')) : undefined);
		await until('paused', () => view()?.status === 'paused' && view()!.frames.length > 0 && view()!.vars.Locals, 20000);
		assert.equal(view()!.frames[0].name, 'square');
		assert.equal(view()!.frames[0].line, 4);
		assert.deepEqual(view()!.vars.Locals.map((x) => [x.name, x.value]), [['x', '7'], ['y', '49']]);
		writeFileSync(file('debug-in.json'), JSON.stringify({ cmds: [{ seq: 1, op: 'continue' }] }));
		await until('exited', () => JSON.parse(readFileSync(file('state.json'), 'utf8')).status === 'exited', 15000);
		assert.equal(JSON.parse(readFileSync(file('state.json'), 'utf8')).code, 3);
		assert.match(readFileSync(file('tail.txt'), 'utf8'), /^49$/m);
	} finally {
		spawnSync(join(root, 'bin/symbiosis'), ['run', 'stop', '--folder', ws, '--all', '--runs', runsDir]);
		rmSync(dir, { recursive: true, force: true });
	}
});
