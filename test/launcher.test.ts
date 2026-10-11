import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseArgs, UsageError } from '../launcher/args.ts';
import { Backend, toDialog, toNotice, toResponse } from '../launcher/backend.ts';
import { ConfigError, DEFAULTS, parseConfig, readConfig } from '../launcher/config.ts';
import { projectFolder } from '../launcher/folder.ts';
import { findOpen, hostOf, recordPath, removeRecord, writeRecord } from '../launcher/record.ts';
import { type Json, splitRecords } from '../launcher/rpc.ts';

function temp(): string {
	return mkdtempSync(join(tmpdir(), 'symbiosis-launcher-'));
}

test('arguments: folder, flags, and the rest for pi after --', () => {
	assert.deepEqual(parseArgs([]), { tab: false, continue: false, fresh: false, piArgs: [], help: false });
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
		assert.deepEqual(parseConfig('{"open":"tab","piArgs":["--model","sonnet"]}', 'c'), { open: 'tab', piArgs: ['--model', 'sonnet'] });
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

test('rpc framing: split on LF only, keep U+2028 inside a record', () => {
	const text = `{"a":"x\u2028y"}\r\n{"b":1}\n{"c":`;
	const { records, rest } = splitRecords(text);
	assert.deepEqual(records, ['{"a":"x\u2028y"}', '{"b":1}']);
	assert.equal(rest, '{"c":');
	assert.equal(JSON.parse(records[0]).a, 'x\u2028y');
});

test('dialogs: requests map to dialogs, answers to responses', () => {
	const confirm = toDialog({ type: 'extension_ui_request', id: 'u1', method: 'confirm', title: 'Allow?', message: 'rm -rf x', timeout: 5000 }, 1000)!;
	assert.deepEqual(confirm, { id: 'u1', method: 'confirm', title: 'Allow?', message: 'rm -rf x', until: 6000 });
	assert.equal(toDialog({ type: 'extension_ui_request', id: 'u2', method: 'setStatus' }, 0), undefined);
	assert.deepEqual(toResponse(confirm, { id: 'u1', confirmed: false }), { type: 'extension_ui_response', id: 'u1', confirmed: false });
	assert.deepEqual(toResponse(confirm, { id: 'u1', value: 'yes' }), { type: 'extension_ui_response', id: 'u1', cancelled: true });
	const select = toDialog({ type: 'extension_ui_request', id: 'u3', method: 'select', title: 'Pick', options: ['Allow', 'Block', 3] }, 0)!;
	assert.deepEqual(select.options, ['Allow', 'Block']);
	assert.deepEqual(toResponse(select, { id: 'u3', value: 'Block' }), { type: 'extension_ui_response', id: 'u3', value: 'Block' });
	assert.deepEqual(toResponse(select, { id: 'u3', value: 'Maybe' }), { type: 'extension_ui_response', id: 'u3', cancelled: true });
	assert.deepEqual(toResponse(select, { id: 'u3', cancelled: true }), { type: 'extension_ui_response', id: 'u3', cancelled: true });
	assert.deepEqual(toNotice({ type: 'extension_ui_request', id: 'n', method: 'notify', message: 'hi', notifyType: 'warning' }), { id: 'n', text: 'hi', level: 'warning' });
});

test('backend: shows the oldest dialog, answers once, sends prompts, drops a dialog pi gave up on', () => {
	const dir = temp();
	let now = 1000;
	const sent: Json[] = [];
	const asked: Json[] = [];
	try {
		const b = new Backend(join(dir, 'b1'), () => now);
		b.attach({ send: (r) => sent.push(r), request: async (c) => asked.push(c) });
		b.setState('ready');
		const ui = () => JSON.parse(readFileSync(join(dir, 'b1', 'ui.json'), 'utf-8'));
		assert.equal(ui().pi, 'ready');
		b.handle({ type: 'extension_ui_request', id: 'd1', method: 'confirm', title: 'One?' });
		b.handle({ type: 'extension_ui_request', id: 'd2', method: 'input', title: 'Two?', timeout: 500 });
		assert.equal(ui().dialog.id, 'd1');
		const ttt = (body: object) => writeFileSync(join(dir, 'b1', 'ttt.json'), JSON.stringify(body));
		ttt({ answers: [{ id: 'd1', confirmed: true }], prompts: [{ id: 'p1', text: 'hello' }, { id: 'p2', text: '  ' }] });
		b.tick();
		b.tick(); // the same answer and prompt again: acted on once
		assert.deepEqual(sent, [{ type: 'extension_ui_response', id: 'd1', confirmed: true }]);
		assert.deepEqual(asked, [{ type: 'prompt', message: 'hello' }]);
		assert.equal(ui().dialog.id, 'd2');
		b.handle({ type: 'agent_start' });
		ttt({ answers: [], prompts: [{ id: 'p3', text: 'more' }] });
		b.tick();
		assert.deepEqual(asked[1], { type: 'prompt', message: 'more', streamingBehavior: 'followUp' });
		assert.equal(ui().working, true);
		now = 1600; // d2's timeout passed: pi took its default
		b.tick();
		assert.equal(ui().dialog, null);
		b.setState('exited');
		ttt({ prompts: [{ id: 'p4', text: 'late' }] });
		b.tick();
		assert.equal(asked.length, 2);
		assert.match(ui().notices.at(-1).text, /not running/);
		b.remove();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
