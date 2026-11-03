import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';

const repo = join(import.meta.dirname, '..');
const base = realpathSync(mkdtempSync(join('/tmp', 'sbk-')));
const plugin = join(base, 'cfg', 'plugins', 'symbiosis');
const run = join(base, 'run');
const ws = join(base, 'ws');
const transcript = join(base, 't.jsonl');
const sessions = join(base, 'claude', 'sessions');
const bin = join(base, 'bin');
const keys = join(base, 'keys.txt');
mkdirSync(plugin, { recursive: true });
mkdirSync(bin);
writeFileSync(join(bin, 'herdr'), `#!/bin/sh\necho "herdr $*" >> '${keys}'\n`);
chmodSync(join(bin, 'herdr'), 0o755);
mkdirSync(sessions, { recursive: true });
mkdirSync(run, { mode: 0o700 });
mkdirSync(ws);
writeFileSync(transcript, '');
const env = { ...process.env, TTT_CONFIG_DIR: join(base, 'cfg'), SYMBIOSIS_RUN_DIR: run, CLAUDE_CONFIG_DIR: join(base, 'claude'), CLAUDE_PID: String(process.pid), HERDR_PANE_ID: 'w1:p7', TMUX: '', PATH: `${bin}:${process.env.PATH}` };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function hook(session: string, event: string, fields: Record<string, unknown> = {}, extra: NodeJS.ProcessEnv = {}): void {
	const input = { session_id: session, transcript_path: transcript, cwd: ws, hook_event_name: event, ...fields };
	const result = spawnSync(process.execPath, [join(repo, 'claude', 'hook.mjs')], { input: JSON.stringify(input), env: { ...env, ...extra }, encoding: 'utf-8' });
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, '', 'a hook prints nothing: Claude would read it');
}

async function until<T>(what: string, check: () => T | undefined | false, ms = 4000): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const value = check();
		if (value) return value;
		if (Date.now() > end) assert.fail(`timed out: ${what}`);
		await sleep(50);
	}
}

const json = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf-8')) : undefined);
const record = (session: string) => json(join(plugin, 'sessions', `${session}.json`));
const pressed = () => (existsSync(keys) ? readFileSync(keys, 'utf-8').trim().split('\n').filter(Boolean) : []);
const events = () => (existsSync(join(plugin, 'events.jsonl')) ? readFileSync(join(plugin, 'events.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

after(() => {
	for (const session of ['s-main', 's-none']) hook(session, 'SessionEnd', { reason: 'other' });
});

test('a Claude session through its hooks: the record, a streamed edit, the tasks, a wait, a rejection, an interrupt, an Esc and a stop', async () => {
	const s = 's-main';
	writeFileSync(join(plugin, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner: s }));
	hook(s, 'SessionStart', { source: 'startup', model: 'claude-haiku-5-5', session_title: 'demo' });
	const started = await until('the record', () => record(s));
	assert.equal(started.agent, 'claude');
	assert.deepEqual(started.can, ['stop', 'close']);
	assert.equal(started.pid, process.pid);
	assert.equal(started.cwd, ws);
	assert.equal(started.model, 'claude-haiku-5-5');
	assert.equal(started.title, 'demo');
	assert.equal(started.pane, 'w1:p7');

	hook(s, 'UserPromptSubmit', { prompt: 'go' });
	assert.equal(record(s).working, true);

	const file = join(ws, 'a.ts');
	writeFileSync(file, 'one\n');
	hook(s, 'PreToolUse', { tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: file, old_string: 'one', new_string: 'two', replace_all: false } });
	assert.deepEqual(
		events().map((e) => e.op),
		['start', 'text', 'text', 'ready'],
		'the keeper sent the call before the hook returned, so before Claude runs the tool',
	);
	assert.equal(events()[0].before, 'one\n');
	writeFileSync(file, 'two\n');
	hook(s, 'PostToolUse', { tool_name: 'Edit', tool_use_id: 't1', tool_input: { file_path: file, old_string: 'one', new_string: 'two' }, tool_response: { structuredPatch: [{ newStart: 1, lines: ['-one', '+two'] }] } });
	const done = events().at(-1);
	assert.deepEqual({ op: done.op, path: done.path, line: done.line, ok: done.ok }, { op: 'done', path: file, line: 1, ok: true });
	assert.equal(json(join(plugin, 'log', s, 'index.json')).changes.length, 1);
	assert.deepEqual(record(s).files, [file]);

	hook(s, 'PostToolUse', { tool_name: 'TaskCreate', tool_use_id: 't2', tool_input: { subject: 'Edit a.ts' }, tool_response: { task: { id: '1', subject: 'Edit a.ts' } } });
	hook(s, 'PostToolUse', { tool_name: 'TaskCreate', tool_use_id: 't3', tool_input: { subject: 'Write b.ts' }, tool_response: { task: { id: '2', subject: 'Write b.ts' } } });
	hook(s, 'PostToolUse', { tool_name: 'TaskUpdate', tool_use_id: 't4', tool_input: { taskId: '1', status: 'completed' }, tool_response: { success: true } });
	assert.deepEqual(record(s).plan, [
		{ text: 'Edit a.ts', state: 'done' },
		{ text: 'Write b.ts', state: 'next' },
	]);

	hook(s, 'PreToolUse', { tool_name: 'Write', tool_use_id: 't5', tool_input: { file_path: join(ws, 'b.ts'), content: 'b\n' } });
	hook(s, 'Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' });
	assert.equal(record(s).waiting, 'Claude needs your permission');
	hook(s, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
	assert.equal(record(s).waiting, 'Claude needs your permission', 'an idle notice is no dialog');

	appendFileSync(transcript, `${JSON.stringify({ type: 'user', isSidechain: false, toolUseResult: 'User rejected tool use', message: { content: [{ type: 'tool_result', tool_use_id: 't5', is_error: true, content: "The user doesn't want to proceed with this tool use." }] } })}\n`);
	appendFileSync(transcript, `${JSON.stringify({ type: 'user', isSidechain: false, message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })}\n`);
	await until('the abort and the stop', () => events().some((e) => e.op === 'abort' && e.call === 't5') && events().at(-1).op === 'stop');
	assert.deepEqual({ path: events().at(-1).path, line: events().at(-1).line }, { path: file, line: 1 }, 'the stop names the last change');
	const now = record(s);
	assert.equal(now.working, false);
	assert.equal(now.waiting, null);

	const status = (fields: Record<string, unknown>) =>
		writeFileSync(join(sessions, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: s, status: 'idle', statusUpdatedAt: Date.now(), ...fields }));
	status({ statusUpdatedAt: Date.now() - 1000 });
	hook(s, 'UserPromptSubmit', { prompt: 'again' });
	assert.equal(record(s).working, true);
	await sleep(1100);
	assert.equal(record(s).working, true, 'an idle status from before the turn does not end it');
	status({ sessionId: 's-other' });
	await sleep(1100);
	assert.equal(record(s).working, true, 'the idle status of another session does not end this turn');
	status({});
	await until('Esc before any output: no hook, no transcript line, only the idle status', () => record(s).working === false, 2500);

	hook(s, 'UserPromptSubmit', { prompt: 'once more' });
	hook(s, 'Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
	assert.equal(record(s).working, false, 'the idle notice also ends a turn that no hook ended');

	writeFileSync(join(plugin, 'stop.json'), JSON.stringify({ id: 'idle-1', to: s }));
	await sleep(400);
	assert.deepEqual(pressed(), [], 'no Esc for an idle Claude');
	hook(s, 'UserPromptSubmit', { prompt: 'long' });
	writeFileSync(join(plugin, 'stop.json'), JSON.stringify({ id: 'stop-1', to: s }));
	await until('Esc to its pane', () => pressed().length > 0);
	assert.deepEqual(pressed(), ['herdr pane send-keys w1:p7 esc']);
	writeFileSync(join(plugin, 'stop.json'), JSON.stringify({ id: 'stop-1', to: s }));
	writeFileSync(join(plugin, 'stop.json'), JSON.stringify({ id: 'stop-2', to: 'someone-else' }));
	await sleep(400);
	assert.equal(pressed().length, 1, 'a request seen before, or for another session, presses nothing');

	hook(s, 'SessionEnd', { reason: 'other' });
	await until('the record goes', () => !record(s));
	await until('the socket goes', () => !existsSync(join(run, `${s}.sock`)));
});

test('a session the editor does not follow: a record, no events; no pane, so no stop; without the ttt plugin no keeper starts', async () => {
	const s = 's-none';
	writeFileSync(join(plugin, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner: 'someone-else' }));
	const before = events().length;
	hook(s, 'SessionStart', { source: 'startup' }, { HERDR_PANE_ID: '' });
	hook(s, 'PreToolUse', { tool_name: 'Write', tool_use_id: 'n1', tool_input: { file_path: join(ws, 'c.ts'), content: 'c\n' } }, { HERDR_PANE_ID: '' });
	const started = await until('the record', () => record(s));
	assert.deepEqual(started.can, ['close']);
	assert.equal(started.pane, null);
	assert.equal(events().length, before);
	hook('s-gone', 'SessionStart', {}, { TTT_CONFIG_DIR: join(base, 'nothing') });
	await sleep(300);
	assert.equal(existsSync(join(run, 's-gone.sock')), false);
});

test('symbiosis close: the keeper sends SIGTERM to its Claude, then ends with it', async () => {
	const s = 's-close';
	const claude = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
	const gone = new Promise<NodeJS.Signals | null>((resolve) => claude.on('exit', (_code, signal) => resolve(signal)));
	const as = { CLAUDE_PID: String(claude.pid) };
	writeFileSync(join(plugin, 'close.json'), JSON.stringify({ id: 'old', to: s }));
	hook(s, 'SessionStart', { source: 'startup' }, as);
	await until('the record', () => record(s));
	await sleep(300);
	assert.equal(claude.exitCode ?? claude.signalCode, null, 'a close request from before the session is old');
	writeFileSync(join(plugin, 'close.json'), JSON.stringify({ id: 'close-1', to: s }));
	assert.equal(await gone, 'SIGTERM');
	await until('the record goes', () => !record(s), 3000);
	await until('the socket goes', () => !existsSync(join(run, `${s}.sock`)));
});

test('a bad session id starts nothing', () => {
	hook('../x', 'SessionStart');
	assert.equal(existsSync(join(run, '../x.sock')), false);
});
