import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs, UsageError } from '../launcher/args.ts';
import { ConfigError, DEFAULTS, parseConfig, readConfig } from '../launcher/config.ts';
import { projectFolder } from '../launcher/folder.ts';
import { findOpen, hostOf, recordPath, removeRecord, writeRecord } from '../launcher/record.ts';
import { label, newTab, noHost, paneFromOutput, piCommand, piStart, shellLine, shellQuote, workspaceOf } from '../launcher/layout.ts';

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

test('layout: shell quoting for the command typed into the pane', () => {
	assert.equal(shellQuote('pi'), 'pi');
	assert.equal(shellQuote('/a b/main.ts'), "'/a b/main.ts'");
	assert.equal(shellQuote("it's"), "'it'\\''s'");
	assert.equal(shellLine(['pi', '--append-system-prompt', 'be brief; no $HOME']), "pi --append-system-prompt 'be brief; no $HOME'");
	assert.match(noHost('/p/my app', ['pi', '-c']), /cd '\/p\/my app' && pi -c/);
});
