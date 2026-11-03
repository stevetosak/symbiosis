import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyTask, callOf, firstLine, MAX_TASKS, stepsOf, type Task } from '../claude/map.ts';
import { TranscriptReader, transcriptEvents } from '../claude/transcript.ts';
import { ownDir, pluginDir as hookPluginDir, socketDir } from '../claude/socket.mjs';
import { pluginDir } from '../core/channel/file.ts';

const REJECTED_LINE = JSON.stringify({
	type: 'user',
	isSidechain: false,
	toolUseResult: 'User rejected tool use',
	message: {
		role: 'user',
		content: [
			{
				type: 'tool_result',
				content: "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
				is_error: true,
				tool_use_id: 'toolu_01',
			},
		],
	},
});
const INTERRUPTED_LINE = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });

test('Claude\'s Edit and Write in the shape the agent side streams; other tools are not followed', () => {
	assert.deepEqual(callOf('Edit', { file_path: '/w/a.ts', old_string: 'one', new_string: 'two', replace_all: false }), {
		tool: 'edit',
		args: { path: '/w/a.ts', edits: [{ oldText: 'one', newText: 'two' }] },
	});
	assert.deepEqual(callOf('Write', { file_path: '/w/b.ts', content: 'x\n' }), { tool: 'write', args: { path: '/w/b.ts', content: 'x\n' } });
	assert.equal(callOf('NotebookEdit', { file_path: '/w/n.ipynb', new_source: 'x' }), undefined);
	assert.equal(callOf('Edit', { file_path: '', old_string: 'a', new_string: 'b' }), undefined);
	assert.equal(callOf('Write', { file_path: '/w/b.ts' }), undefined);
	assert.equal(callOf('Edit', null), undefined);
});

test('the first changed line from the structured patch: past the context lines; a new file starts at 1', () => {
	const patch = [{ oldStart: 23, oldLines: 3, newStart: 23, newLines: 7, lines: ['   items.splice(index, 1);', '   return true;', ' }', '+', '+export function count(): number {', '+  return items.length;', '+}'] }];
	assert.equal(firstLine({ structuredPatch: patch }), 26);
	assert.equal(firstLine({ type: 'create', structuredPatch: [] }), 1);
	assert.equal(firstLine({ structuredPatch: [{ newStart: 4, lines: ['-gone'] }] }), 4);
	assert.equal(firstLine(undefined), 1);
});

test('the task tools as plan steps: created pending, then in progress, then done; deleted goes', () => {
	let tasks: Task[] = [];
	tasks = applyTask(tasks, 'TaskCreate', { subject: 'Add clear()', description: 'x' }, { task: { id: '1', subject: 'Add clear()' } });
	tasks = applyTask(tasks, 'TaskCreate', { subject: 'Check it' }, { task: { id: '2', subject: 'Check it' } });
	tasks = applyTask(tasks, 'TaskCreate', { subject: 'Drop me' }, { task: { id: '3', subject: 'Drop me' } });
	tasks = applyTask(tasks, 'TaskUpdate', { taskId: '1', status: 'in_progress' }, { success: true });
	assert.deepEqual(stepsOf(tasks), [
		{ text: 'Add clear()', state: 'now' },
		{ text: 'Check it', state: 'next' },
		{ text: 'Drop me', state: 'next' },
	]);
	tasks = applyTask(tasks, 'TaskUpdate', { taskId: '1', status: 'completed' }, {});
	tasks = applyTask(tasks, 'TaskUpdate', { taskId: '2', subject: 'Check clear()' }, {});
	tasks = applyTask(tasks, 'TaskUpdate', { taskId: '3', status: 'deleted' }, {});
	tasks = applyTask(tasks, 'TaskUpdate', { taskId: '9', status: 'completed' }, {});
	tasks = applyTask(tasks, 'TaskUpdate', { taskId: '2', status: 'bogus' }, {});
	assert.deepEqual(stepsOf(tasks), [
		{ text: 'Add clear()', state: 'done' },
		{ text: 'Check clear()', state: 'next' },
	]);
	assert.deepEqual(applyTask([], 'TaskCreate', { subject: 'no id' }, {}), [], 'no task without the id Claude gave it');
});

test('the task list keeps its newest tasks and cuts a long subject', () => {
	let tasks: Task[] = [];
	for (let i = 0; i < MAX_TASKS + 5; i++) tasks = applyTask(tasks, 'TaskCreate', { subject: `t${i}` }, { task: { id: `${i}` } });
	assert.equal(tasks.length, MAX_TASKS);
	assert.equal(tasks[0].subject, 't5');
	const long = applyTask([], 'TaskCreate', { subject: 'x'.repeat(500) }, { task: { id: '1' } });
	assert.equal(long[0].subject.length, 200);
});

test('the transcript: a rejected call, an interrupt; request blobs and side chains do not count', () => {
	assert.deepEqual(transcriptEvents(REJECTED_LINE), [{ kind: 'result', call: 'toolu_01', rejected: true }]);
	assert.deepEqual(transcriptEvents(INTERRUPTED_LINE), [{ kind: 'interrupted' }]);
	assert.deepEqual(transcriptEvents(JSON.stringify({ type: 'user', message: { content: '[Request interrupted by user]' } })), [{ kind: 'interrupted' }]);
	assert.deepEqual(transcriptEvents(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: 'ok' }] } })), [
		{ kind: 'result', call: 'toolu_02', rejected: false },
	]);
	assert.deepEqual(transcriptEvents(REJECTED_LINE.replace('"type":"user"', '"type":"api-request-blob"')), []);
	assert.deepEqual(transcriptEvents(INTERRUPTED_LINE.replace('"isSidechain":false', '"isSidechain":true')), []);
	assert.deepEqual(transcriptEvents('{not json'), []);
	assert.deepEqual(transcriptEvents(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '[Request interrupted by user' }] } })), []);
});

test('the transcript reader gives each complete line once, and keeps a part line for later', () => {
	const file = Buffer.from(`${REJECTED_LINE}\n${INTERRUPTED_LINE}\n`);
	const cut = REJECTED_LINE.length + 10;
	const reader = new TranscriptReader('/t.jsonl', 0);
	const reads = [file.subarray(0, cut), file.subarray(cut), undefined];
	const read = () => reads.shift();
	assert.deepEqual(reader.take(read), [{ kind: 'result', call: 'toolu_01', rejected: true }]);
	assert.deepEqual(reader.take(read), [{ kind: 'interrupted' }]);
	assert.deepEqual(reader.take(read), []);
});

test('the hook finds the ttt plugin where the agent side writes, and its socket folder must be the user\'s own', () => {
	for (const env of [{}, { TTT_CONFIG_DIR: '/c/ttt' }]) assert.equal(hookPluginDir(env, '/home/me'), pluginDir(env, '/home/me'));
	assert.equal(socketDir({}, 501), '/tmp/symbiosis-501');
	assert.equal(socketDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, 1000), '/run/user/1000/symbiosis');
	assert.equal(socketDir({ SYMBIOSIS_RUN_DIR: '/x', XDG_RUNTIME_DIR: '/run/user/1' }, 1), '/x');
	const dir = mkdtempSync(join('/tmp', 'sbk-own-'));
	assert.equal(ownDir(dir), true);
	assert.equal(ownDir(dir, process.getuid!() + 1), false, 'a folder of another user is refused');
	chmodSync(dir, 0o777);
	assert.equal(ownDir(dir), false, 'a folder others can write is refused');
});
