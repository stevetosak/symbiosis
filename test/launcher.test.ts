import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs, UsageError } from '../launcher/args.ts';
import { ConfigError, DEFAULTS, parseConfig, readConfig } from '../launcher/config.ts';
import { projectFolder } from '../launcher/folder.ts';
import { findByPid, findOpen, hostOf, recordPath, removeRecord, writeRecord } from '../launcher/record.ts';
import { closePi, parseCloseArgs, quitEditor, sessionPid, target } from '../launcher/close.ts';
import type { Session } from '../core/protocol.ts';
import { closePane, currentTab, goTo, herdrPlace, label, newTab, noHost, paneFromOutput, piCommand, piStart, renameTab, restoreTab, shellLine, shellQuote, workspaceOf } from '../launcher/layout.ts';

function temp(): string {
	return mkdtempSync(join(tmpdir(), 'symbiosis-launcher-'));
}

test('arguments: folder, flags, and the rest for pi after --', () => {
	assert.deepEqual(parseArgs([]), { tab: false, here: false, continue: false, fresh: false, piArgs: [], help: false });
	assert.equal(parseArgs(['--split']).layout, 'split');
	assert.equal(parseArgs(['--tabs']).layout, 'tabs');
	assert.equal(parseArgs(['--here']).here, true);
	assert.throws(() => parseArgs(['--tab', '--here']), /not both/);
	const a = parseArgs(['src', '--tab', '-c', '--new', '--', '--model', 'sonnet', '-c']);
	assert.equal(a.folder, 'src');
	assert.equal(a.tab, true);
	assert.equal(a.continue, true);
	assert.equal(a.fresh, true);
	assert.deepEqual(a.piArgs, ['--model', 'sonnet', '-c']);
	assert.throws(() => parseArgs(['--model', 'x']), UsageError);
	assert.throws(() => parseArgs(['a', 'b']), UsageError);
});

test('config: defaults, values, and a clear stop on a broken file', () => {
	const dir = temp();
	try {
		assert.deepEqual(readConfig(join(dir, 'none.json')), DEFAULTS);
		assert.equal(DEFAULTS.layout, 'tabs');
		assert.deepEqual(parseConfig('{"open":"tab","layout":"split","piArgs":["--model","sonnet"]}', 'c'), { open: 'tab', layout: 'split', piArgs: ['--model', 'sonnet'] });
		assert.throws(() => parseConfig('{"layout":"grid"}', 'c'), /"layout" must be/);
		assert.throws(() => parseConfig('{"open":"tab",}', 'c'), (e: Error) => e instanceof ConfigError && /not valid JSON/.test(e.message));
		assert.throws(() => parseConfig('{"open":"split"}', 'c'), /"open" must be/);
		assert.throws(() => parseConfig('{"piArgs":"--model x"}', 'c'), /list of strings/);
		assert.throws(() => parseConfig('{"opne":"tab"}', 'c'), /unknown key "opne"/);
		assert.throws(() => parseConfig('[]', 'c'), /one JSON object/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('folder: the argument, else the git root, else here', () => {
	const dir = temp();
	try {
		mkdirSync(join(dir, 'sub'));
		writeFileSync(join(dir, 'file.txt'), '');
		assert.equal(projectFolder('sub', dir, () => undefined), join(dir, 'sub'));
		assert.equal(projectFolder(undefined, join(dir, 'sub'), () => dir), dir);
		assert.equal(projectFolder(undefined, join(dir, 'sub'), () => undefined), join(dir, 'sub'));
		assert.throws(() => projectFolder('missing', dir), UsageError);
		assert.throws(() => projectFolder('file.txt', dir), /not a folder/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('record: a live one is found, an old one is removed, a --new run keeps the other', () => {
	const dir = temp();
	try {
		writeRecord(dir, { pid: 11, folder: '/p', started: 1, host: { kind: 'herdr', pane: 'w1:p2' } });
		assert.equal(findOpen(dir, '/p', () => true)?.host?.pane, 'w1:p2');
		assert.equal(findOpen(dir, '/q', () => true), undefined);
		removeRecord(dir, '/p', 12); // not its own: stays
		assert.ok(findOpen(dir, '/p', () => true));
		assert.equal(findOpen(dir, '/p', () => false), undefined);
		assert.throws(() => readFileSync(recordPath(dir, '/p')));
		assert.deepEqual(hostOf({ HERDR_PANE_ID: 'w4:p1' }), { kind: 'herdr', pane: 'w4:p1' });
		assert.deepEqual(hostOf({ TMUX: '/tmp/t,1,0', TMUX_PANE: '%3' }), { kind: 'tmux', pane: '%3' });
		assert.equal(hostOf({}), null);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('layout: pi in a tab of its own by default, or split to the right', () => {
	const herdr = { kind: 'herdr' as const, pane: 'w4:p1' };
	const tmux = { kind: 'tmux' as const, pane: '%3' };
	const pi = piCommand('pi', true, ['--model', 'sonnet'], ['--thinking', 'high']);
	assert.deepEqual(pi, ['pi', '--continue', '--model', 'sonnet', '--thinking', 'high']);
	assert.equal(label('/home/x/my app', 'pi'), 'pi · my app');
	assert.equal(workspaceOf('w4:p1'), 'w4');

	const tab = piStart(herdr, 'tabs', '/p/app', pi);
	assert.deepEqual(tab.create, ['herdr', 'tab', 'create', '--workspace', 'w4', '--cwd', '/p/app', '--label', 'pi · app']);
	assert.deepEqual(tab.run('w4:pJ'), [['herdr', 'pane', 'run', 'w4:pJ', 'pi --continue --model sonnet --thinking high']]);
	const split = piStart(herdr, 'split', '/p/app', ['pi']);
	assert.deepEqual(split.create, ['herdr', 'pane', 'split', 'w4:p1', '--direction', 'right', '--cwd', '/p/app', '--no-focus']);

	assert.deepEqual(piStart(tmux, 'tabs', '/p/app', ['pi']).create, ['tmux', 'new-window', '-d', '-P', '-F', '#{pane_id}', '-c', '/p/app', '-n', 'pi · app']);
	assert.deepEqual(piStart(tmux, 'split', '/p/app', ['pi']).create, ['tmux', 'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', '%3', '-c', '/p/app']);
	assert.deepEqual(piStart(tmux, 'tabs', '/p/app', ['pi']).run('%9'), [
		['tmux', 'send-keys', '-t', '%9', '-l', 'pi'],
		['tmux', 'send-keys', '-t', '%9', 'Enter'],
	]);
	// The ttt tab of `open: tab` takes the focus.
	assert.ok(newTab(herdr, '/p/app', 'app', true, ['x']).create.includes('--focus'));
	assert.ok(!newTab(tmux, '/p/app', 'app', true, ['x']).create.includes('-d'));
});

test('layout: pane ids from herdr and tmux, and a clear error', () => {
	assert.equal(paneFromOutput('herdr', '{"result":{"root_pane":{"pane_id":"w4:pJ"},"tab":{"tab_id":"w4:tD"}}}'), 'w4:pJ');
	assert.equal(paneFromOutput('herdr', '{"result":{"pane":{"pane_id":"w4:pK"}}}'), 'w4:pK');
	assert.throws(() => paneFromOutput('herdr', '{"error":{"code":"x","message":"no such pane"}}'), /no such pane/);
	assert.throws(() => paneFromOutput('herdr', 'oops'), /not answer in JSON/);
	assert.equal(paneFromOutput('tmux', '%12\n'), '%12');
	assert.throws(() => paneFromOutput('tmux', ''), /did not print a pane id/);
});

test('layout: going to a running symbiosis', () => {
	const place = herdrPlace('{"result":{"pane":{"pane_id":"w4:p3","tab_id":"w4:t2","workspace_id":"w4"},"type":"pane_info"}}');
	assert.deepEqual(place, { workspace: 'w4', tab: 'w4:t2' });
	assert.deepEqual(goTo({ kind: 'herdr', pane: 'w4:p3' }, place), [
		['herdr', 'workspace', 'focus', 'w4'],
		['herdr', 'tab', 'focus', 'w4:t2'],
	]);
	assert.equal(herdrPlace('{"error":{"message":"pane not found"}}'), undefined);
	assert.equal(herdrPlace('not json'), undefined);
	assert.deepEqual(goTo({ kind: 'herdr', pane: 'w4:p3' }), []);
	assert.deepEqual(goTo({ kind: 'tmux', pane: '%3' }), [
		['tmux', 'select-window', '-t', '%3'],
		['tmux', 'select-pane', '-t', '%3'],
	]);
});

test('layout: shell quoting for the command typed into the pane', () => {
	assert.equal(shellQuote('pi'), 'pi');
	assert.equal(shellQuote('/a b/main.ts'), "'/a b/main.ts'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
	assert.equal(shellLine(['pi', '--append-system-prompt', 'be brief; no $HOME']), "pi --append-system-prompt 'be brief; no $HOME'");
	assert.match(noHost('/p/my app', ['pi', '-c']), /cd '\/p\/my app' && pi -c/);
});

test('tab name: read from herdr and tmux, set, and given back', () => {
	const herdr = { kind: 'herdr', pane: 'w4:p1' } as const;
	const tmux = { kind: 'tmux', pane: '%3' } as const;
	const answers: Record<string, string> = {
		'herdr pane get w4:p1': '{"result":{"pane":{"tab_id":"w4:t2","workspace_id":"w4"}}}',
		'herdr tab get w4:t2': '{"result":{"tab":{"label":"2","tab_id":"w4:t2"}}}',
		'tmux display-message -p -t %3 #{window_id}\t#{window_name}\t#{automatic-rename}': '@5\tzsh\t1\n',
	};
	const run = (argv: string[]) => {
		const out = answers[argv.join(' ')];
		if (out === undefined) throw new Error(`unexpected ${argv.join(' ')}`);
		return out;
	};
	assert.deepEqual(currentTab(herdr, run), { id: 'w4:t2', label: '2', automatic: false });
	assert.deepEqual(currentTab(tmux, run), { id: '@5', label: 'zsh', automatic: true });
	assert.equal(currentTab({ kind: 'herdr', pane: 'gone' }, run), undefined, 'a failing multiplexer: no name, no rename');
	assert.deepEqual(renameTab(herdr, { id: 'w4:t2' }, label('/w/shop', 'ttt')), ['herdr', 'tab', 'rename', 'w4:t2', 'ttt · shop']);
	assert.deepEqual(renameTab(tmux, { id: '@5' }, 'ttt · shop'), ['tmux', 'rename-window', '-t', '@5', 'ttt · shop']);
	assert.deepEqual(restoreTab(herdr, { id: 'w4:t2', label: '2', automatic: false }), [['herdr', 'tab', 'rename', 'w4:t2', '2']]);
	assert.deepEqual(restoreTab(tmux, { id: '@5', label: 'zsh', automatic: true }), [['tmux', 'set-window-option', '-t', '@5', 'automatic-rename', 'on']]);
	assert.deepEqual(restoreTab(tmux, { id: '@5', label: 'logs', automatic: false }), [['tmux', 'rename-window', '-t', '@5', 'logs']]);
	assert.deepEqual(restoreTab(herdr, { id: 'w4:t2', label: '', automatic: false }), [], 'no old name: nothing to give back');
	assert.deepEqual(closePane(herdr, 'w4:pT'), ['herdr', 'pane', 'close', 'w4:pT']);
	assert.deepEqual(closePane(tmux, '%7'), ['tmux', 'kill-pane', '-t', '%7']);
});

test('close: arguments, the launcher of this ttt, and the record by process', () => {
	assert.deepEqual(parseCloseArgs([]), { keepEditor: false, help: false });
	assert.deepEqual(parseCloseArgs(['src', '--keep-editor']), { folder: 'src', keepEditor: true, help: false });
	assert.throws(() => parseCloseArgs(['--now']), UsageError);
	assert.throws(() => parseCloseArgs(['a', 'b']), UsageError);
	assert.equal(sessionPid('4242-mabc'), 4242);
	assert.equal(sessionPid('x-1'), undefined);
	assert.equal(sessionPid(undefined), undefined);
	const dir = temp();
	try {
		writeRecord(dir, { pid: 4242, folder: '/p', started: 1, host: null, pi: null });
		writeRecord(dir, { pid: 5, folder: '/q', started: 1, host: null });
		assert.equal(findByPid(dir, 4242, () => true)?.folder, '/p');
		assert.equal(findByPid(dir, 4242, () => false), undefined);
		assert.equal(findByPid(join(dir, 'none'), 4242, () => true), undefined);
		// Inside ttt the session names the launcher; a folder on the command line wins.
		assert.equal(target({ keepEditor: false, help: false }, { SYMBIOSIS_SESSION: '4242-m1' }, dir, () => '/q')?.folder, '/p');
		writeRecord(dir, { pid: process.pid, folder: '/r', started: 1, host: null });
		assert.equal(target({ folder: 'x', keepEditor: false, help: false }, { SYMBIOSIS_SESSION: '4242-m1' }, dir, () => '/r')?.folder, '/r', 'a folder on the command line wins');
		assert.equal(target({ keepEditor: false, help: false }, {}, dir, () => '/nope'), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('close: pi quits first, then its pane closes; a pi that stays keeps its pane', async () => {
	const host = { kind: 'herdr', pane: 'w1:p1' } as const;
	const record = { pid: 1, folder: '/p', started: 1, host, pi: 'w1:pT' };
	const session = (over: Partial<Session> = {}) => ({ id: 's1', pane: 'w1:pT', host: 'herdr', pid: 900, name: 'p', ...over }) as Session;
	const make = (sessions: Session[], alivePid: () => boolean) => {
		const calls: string[] = [];
		const said: string[] = [];
		const deps = {
			channel: { sessions: () => sessions, requestClose: (to: string) => void calls.push(`close ${to}`) },
			run: (argv: string[]) => void calls.push(argv.join(' ')),
			isAlive: alivePid,
			sleep: async () => {},
			say: (line: string) => void said.push(line),
			waitMs: 50,
		};
		return { deps, calls, said };
	};

	// pi quits after the request: the pane closes after that.
	let up = true;
	const quits = make([session()], () => up);
	quits.deps.channel.requestClose = (to) => {
		quits.calls.push(`close ${to}`);
		up = false;
	};
	assert.deepEqual(await closePi(record, quits.deps), { ok: true });
	assert.deepEqual(quits.calls, ['close s1', 'herdr pane close w1:pT']);

	// pi does not quit in time: the pane stays and the command fails.
	const stuck = make([session()], () => true);
	stuck.deps.sleep = () => new Promise((r) => setTimeout(r, 20));
	assert.deepEqual(await closePi(record, stuck.deps), { ok: false });
	assert.deepEqual(stuck.calls, ['close s1']);
	assert.match(stuck.said.join(), /did not quit/);

	// Another pane's session, or a session whose process is gone: nothing is closed.
	const other = make([session({ pane: 'w1:p9' }), session({ id: 's2', pid: 901 })], (pid) => pid === 900);
	assert.deepEqual(await closePi(record, other.deps), { ok: true });
	assert.deepEqual(other.calls, []);
	assert.match(other.said.join(), /does not run in herdr pane w1:pT/);

	// No pane of ours (no herdr, no tmux): no pi is closed.
	const none = make([session()], () => true);
	assert.deepEqual(await closePi({ ...record, host: null, pi: null }, none.deps), { ok: true });
	assert.deepEqual(none.calls, []);
});

test('close: ttt is asked to quit, and the command waits for it', async () => {
	const record = { pid: 1, folder: '/p', started: 1, host: null };
	const said: string[] = [];
	let asked = 0;
	let up = true;
	const deps = {
		channel: { sessions: () => [], requestClose: () => {}, requestQuit: () => void (asked++, (up = false)) },
		run: () => {},
		isAlive: () => up,
		sleep: async () => {},
		say: (line: string) => void said.push(line),
		waitMs: 50,
	};
	assert.deepEqual(await quitEditor(record, deps), { ok: true });
	assert.equal(asked, 1);
	// ttt asks about something and waits: the command says so and fails.
	const slow = { ...deps, channel: { ...deps.channel, requestQuit: () => {} }, isAlive: () => true, sleep: () => new Promise<void>((r) => setTimeout(r, 20)) };
	assert.deepEqual(await quitEditor(record, slow), { ok: false });
	assert.match(said.join(), /has not quit: it may ask/);
});
