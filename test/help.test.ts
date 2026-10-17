import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askMessage, helpPrompt, lastAssistantText, parseAnswer, parseRequest } from '../core/help.ts';
import type { HelpRequest } from '../core/protocol.ts';

const request = (over: Partial<HelpRequest> = {}): HelpRequest => ({
	id: 'h1',
	to: 's1',
	path: '/w/src/a.ts',
	line: 2,
	question: '\t// how do I make the folder here helpi!',
	language: 'typescript',
	head: '',
	window: { first: 1, text: 'export function save(dir: string) {\n\t// how do I make the folder here helpi!\n}' },
	cancel: false,
	...over,
});

test('the kind waits for the end of the first line', () => {
	assert.deepEqual(parseAnswer('co', false), { imports: [], body: '', settled: false });
	assert.equal(parseAnswer('code\nmkdir', false).kind, 'code');
	assert.equal(parseAnswer('Note\nok', false).kind, 'note');
	assert.equal(parseAnswer('**ask**\n', false).kind, 'ask');
});

test('code: imports first, then the body; a possible import waits', () => {
	assert.equal(parseAnswer('code\n+imp', false).settled, false);
	assert.equal(parseAnswer("code\n+import import { mkdirSync } from 'node:fs';", false).settled, false);
	const a = parseAnswer("code\n+import import { mkdirSync } from 'node:fs';\nmkdirSync(dir, { recursive: true });\n", true);
	assert.deepEqual(a.imports, ["import { mkdirSync } from 'node:fs';"]);
	assert.equal(a.body, 'mkdirSync(dir, { recursive: true });');
	assert.equal(a.settled, true);
	// No imports: the body starts at once.
	assert.deepEqual(parseAnswer('code\nfor (', false), { kind: 'code', imports: [], body: 'for (', settled: true });
});

test('fences go, also a fence still being written', () => {
	assert.equal(parseAnswer('code\n```ts\nx();\n```\n', true).body, 'x();');
	assert.equal(parseAnswer('code\nx();\n``', false).body, 'x();\n');
	assert.equal(parseAnswer('code\n`a`', false).body, '`a`');
});

test('a note drops a "pi:" the model wrote; no kind line means a note', () => {
	assert.equal(parseAnswer('note\npi: Because it is any.\n', true).body, 'Because it is any.');
	assert.deepEqual(parseAnswer('Because it is any.', true), { kind: 'note', imports: [], body: 'Because it is any.', settled: true });
});

test('ask and function have no body', () => {
	assert.deepEqual(parseAnswer('ask\nwhatever', true), { kind: 'ask', imports: [], body: '', settled: true });
	assert.deepEqual(parseAnswer('function\nexport function f() {}', true), { kind: 'function', imports: [], body: '', settled: true });
	assert.equal(parseAnswer('function\n', false).kind, 'function', 'known at the end of the first line');
});

test('the prompt numbers the lines and names the comment', () => {
	const text = helpPrompt(request(), '/w', [{ text: 'save notes', state: 'now' }], 'I added save().');
	assert.match(text, /^File: src\/a\.ts \(typescript\)/);
	assert.match(text, /The whole file:\n {4}1\| export function save/);
	assert.match(text, / {4}2\| \t\/\/ how do I make/);
	assert.match(text, /The comment is line 2:\n\/\/ how do I make the folder here helpi!/);
	assert.match(text, /- \[now\] save notes/);
	assert.match(text, /The agent's last message:\nI added save\(\)\./);
	const long = helpPrompt(request({ head: 'import a;', window: { first: 40, text: 'x\ny' } }), '/w', [], undefined);
	assert.match(long, /The top of the file:\n {4}1\| import a;/);
	assert.match(long, /Lines 40-41:\n {3}40\| x/);
});

test('the message to the main session has the question without the marker', () => {
	const text = askMessage(request(), '/w');
	assert.match(text, /^A question from the editor \(helpi!\), at src\/a\.ts:2:\n\nhow do I make the folder here\n/);
});

test('a request needs an id and a session', () => {
	assert.equal(parseRequest({ id: 'x' }), undefined);
	assert.equal(parseRequest(null), undefined);
	assert.equal(parseRequest({ id: 'x', to: 's', cancel: true })?.cancel, true);
});

test('the last assistant text on the branch', () => {
	const branch = [
		{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } },
		{ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall' }] } },
		{ type: 'message', message: { role: 'user', content: 'hi' } },
	];
	assert.equal(lastAssistantText(branch), 'first');
	assert.equal(lastAssistantText([]), undefined);
	assert.equal(lastAssistantText([{ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'abcdef' }] } }], 3), '…def');
});
