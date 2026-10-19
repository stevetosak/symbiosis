// ask, without ttt: the request parser, the prompt, the answer parser (core/ask.ts), and the pi side end to end:
// the fake pi loads the real extension; the test plays the editor by writing ask.json and reading events.jsonl.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ASK_SYSTEM, askPrompt, isNotesDir, parseAskAnswer, parseAskRequest } from '../core/ask.ts';
import type { AskRequest } from '../core/protocol.ts';
import { syntaxFor } from '../core/syntax/parse.ts';

const base = mkdtempSync(join(tmpdir(), 'symbiosis-ask-'));
process.env.TTT_CONFIG_DIR = join(base, 'cfg');
const plugin = join(base, 'cfg', 'plugins', 'symbiosis');
const ws = join(base, 'ws');
mkdirSync(plugin, { recursive: true });
mkdirSync(ws);
const { FakePi, sleep } = await import('../demo/fake-pi.ts');

const SOURCE = `import { readFile } from 'node:fs/promises';

/** Adds up the numbers in a file. */
export async function sumFile(path: string): Promise<number> {
	// TODO(pi)
	throw new Error('not written');
}

export function retry(times: number): number {
	let n = 0;
	for (let i = 0; i < times; i++) {
		n += 1;
	}
	return n;
}

const top = 1;
`;

const request = (over: Partial<AskRequest> = {}): AskRequest => ({
	id: 'a1',
	to: 's1',
	path: '/w/a.ts',
	language: 'typescript',
	question: '',
	target: { startLine: 11, endLine: 11, text: '\tfor (let i = 0; i < times; i++) {' },
	word: 'times',
	notesDir: '',
	text: SOURCE,
	window: { first: 1, text: '' },
	deeper: false,
	cancel: false,
	...over,
});
const ctx = (over = {}) => ({ plan: [], whys: [], cwd: '/w', ...over });

test('the request: a bad one is nothing, a missing field is a default', () => {
	assert.equal(parseAskRequest(null), undefined);
	assert.equal(parseAskRequest({ id: 3, to: 's' }), undefined);
	const r = parseAskRequest({ id: 'a', to: 's', path: '/w/a.ts', target: { startLine: 4, endLine: 2, text: 'x' } });
	assert.deepEqual(r?.target, { startLine: 4, endLine: 4, text: 'x' }, 'the end is not before the start');
	assert.equal(r?.deeper, false);
	assert.equal(r?.cancel, false);
	assert.equal(r?.parent, undefined);
	assert.equal(r?.notesDir, '');
	assert.deepEqual(parseAskRequest({ id: 'a', to: 's', parent: { question: 'q', answer: 'a' } })?.parent, { question: 'q', answer: 'a' });
	assert.equal(parseAskRequest({ id: 'a', to: 's', parent: { question: 'q' } })?.parent, undefined);
});

test('the prompt: the function around the code, with line numbers, and the plan and the why', async () => {
	const outline = (await syntaxFor('/w/a.ts'))?.outline(SOURCE);
	const p = askPrompt(request({ question: 'why a loop?' }), ctx({ outline, plan: [{ text: 'sum', state: 'now' }], whys: ['a loop is the simplest'] }));
	assert.match(p, /File: a\.ts \(typescript\)/);
	assert.match(p, /The file imports: node:fs\/promises/);
	assert.match(p, /The function around it, `retry`, lines 9-15:/);
	assert.match(p, /\n {4}9\| export function retry/);
	assert.doesNotMatch(p, /sumFile/, 'only the function that holds the code');
	assert.match(p, /The developer asks about line 11:\n```\n\tfor \(let i/);
	assert.match(p, /The symbol under the cursor: `times`/);
	assert.match(p, /Their question: why a loop\?/);
	assert.match(p, /Its reasons, in its words:\n- a loop is the simplest/);
	assert.match(p, /- \[now\] sum/);
});

test('the prompt: a stub says so, with its signature and intent', async () => {
	const outline = (await syntaxFor('/w/a.ts'))?.outline(SOURCE);
	const p = askPrompt(request({ target: { startLine: 5, endLine: 5, text: '\t// TODO(pi)' }, word: '' }), ctx({ outline }));
	assert.match(p, /Its doc: Adds up the numbers in a file\./);
	assert.match(p, /left this function as a stub for the coding agent \(signature: async function sumFile\(path: string\): Promise<number>/);
});

test('the prompt: code in no function gets the lines around it; a window stands for a big file', async () => {
	const outline = (await syntaxFor('/w/a.ts'))?.outline(SOURCE);
	const top = askPrompt(request({ target: { startLine: 17, endLine: 17, text: 'const top = 1;' }, word: 'top' }), ctx({ outline }));
	assert.match(top, /The code around it, lines 5-18:/);
	assert.doesNotMatch(top, /The function around it/);
	const windowed = askPrompt(
		request({ text: '', window: { first: 100, text: 'a\nb\nc\nd' }, target: { startLine: 102, endLine: 102, text: 'c' } }),
		ctx(),
	);
	assert.match(windowed, /The code around it, lines 100-103:\n {2}100\| a/);
});

test('the prompt: a long function is cut, and a drill-down brings the answer before', async () => {
	const body = Array.from({ length: 100 }, (_, i) => `\tn += ${i};`).join('\n');
	const long = `export function big(): number {\n\tlet n = 0;\n${body}\n\treturn n;\n}\n`;
	const outline = (await syntaxFor('/w/b.ts'))?.outline(long);
	const p = askPrompt(request({ text: long, path: '/w/b.ts', target: { startLine: 4, endLine: 4, text: '\tn += 1;' }, parent: { question: 'q1', answer: 'it adds' }, deeper: true }), ctx({ outline }));
	assert.match(p, /\(the first 60 lines\)/);
	assert.doesNotMatch(p, /n \+= 90;/);
	assert.match(p, /Earlier question: q1\nEarlier answer:\nit adds/);
	assert.match(p, /wants a deeper answer/);
});

test('the answer: lines, then links and terms; half a section head waits', () => {
	const raw = 'It retries `times` times.\nThe count is returned.\n\nlinks:\n- the loop | a.ts:11\n- MDN | https://developer.mozilla.org/x\n- bad | nowhere\nterms:\n- retry\n- `loop`\n- retry\n';
	const a = parseAskAnswer(raw, true);
	assert.equal(a.text, 'It retries `times` times.\nThe count is returned.');
	assert.deepEqual(a.links, [
		{ title: 'the loop', target: 'a.ts:11', kind: 'file' },
		{ title: 'MDN', target: 'https://developer.mozilla.org/x', kind: 'url' },
	]);
	assert.deepEqual(a.terms, ['retry', 'loop']);
	assert.equal(parseAskAnswer('One line.\nlin', false).text, 'One line.', 'maybe the head of `links:`');
	assert.equal(parseAskAnswer('One line.\nlinear', false).text, 'One line.\nlinear');
	assert.equal(parseAskAnswer('One.\nlinks:\n- a | b.ts:1', false).links.length, 0, 'the last line may be unfinished');
	assert.equal(parseAskAnswer('One.\nlinks:\n- a | b.ts:1\n- c | d.ts:2', false).links.length, 1);
	assert.equal(parseAskAnswer('One.\nlinks:\n- a | b.ts:1', true).links.length, 1);
	assert.equal(parseAskAnswer('\n\nOne', true).text, 'One');
});

test('the answer: at most 4 links and 5 terms; a long term is dropped', () => {
	const links = Array.from({ length: 7 }, (_, i) => `- l${i} | a.ts:${i + 1}`).join('\n');
	const terms = ['a', 'b', 'c', 'd', 'e', 'f', 'x'.repeat(41)].map((t) => `- ${t}`).join('\n');
	const a = parseAskAnswer(`Text.\nlinks:\n${links}\nterms:\n${terms}\n`, true);
	assert.equal(a.links.length, 4);
	assert.deepEqual(a.terms, ['a', 'b', 'c', 'd', 'e']);
});

test('only a folder under .symbiosis/notes is made for a note', () => {
	assert.equal(isNotesDir('/w/.symbiosis/notes'), true);
	assert.equal(isNotesDir('/w/.symbiosis/notes/src/deep'), true);
	assert.equal(isNotesDir('/w/.symbiosis/run'), false);
	assert.equal(isNotesDir('/w/.symbiosis/notes/../../etc'), false);
	assert.equal(isNotesDir('.symbiosis/notes'), false, 'absolute only');
	assert.equal(isNotesDir(''), false);
});

test('the system prompt asks for a link and says what a drill-down is', () => {
	assert.match(ASK_SYSTEM, /Give at least one link/);
	assert.match(ASK_SYSTEM, /drills down into a term/);
});

// The pi side ------------------------------------------------------------------------

const file = join(ws, 'a.ts');
const REPLY = 'It retries `times` times.\nThe count comes back.\nlinks:\n- the loop | a.ts:11\nterms:\n- retry\n';
let pi: InstanceType<typeof FakePi>;
let id = '';
let seq = 0;

const events = () =>
	(existsSync(join(plugin, 'events.jsonl')) ? readFileSync(join(plugin, 'events.jsonl'), 'utf-8') : '')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as { op: string; id?: string; text?: string; links?: unknown[]; terms?: string[]; error?: string; stopped?: boolean });

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 80 && !check(); i++) await sleep(50);
	assert.ok(check(), what);
}

function ask(over: Partial<AskRequest> = {}): string {
	const req = request({ id: `a${++seq}`, to: id, path: file, ...over });
	writeFileSync(join(plugin, 'ask.json'), JSON.stringify(req));
	return req.id;
}

before(async () => {
	writeFileSync(file, SOURCE);
	copyFileSync(file, join(ws, 'b.ts'));
	pi = new FakePi({ cwd: ws, chunk: 8, stepMs: 5, answer: () => REPLY });
	await pi.start();
	id = pi.sessionId() ?? '';
	assert.ok(id);
	writeFileSync(join(plugin, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner: id }));
});

after(async () => {
	await pi.stop();
	rmSync(base, { recursive: true, force: true });
});

test('pi answers an ask in a side call: events, links and terms; the agent is not asked', async () => {
	const aid = ask({ question: 'why a loop?', notesDir: join(ws, '.symbiosis', 'notes', 'deep') });
	await until(() => events().some((e) => e.op === 'ask_done' && e.id === aid), 'ask_done');
	const mine = events().filter((e) => e.id === aid);
	assert.deepEqual(mine[0], { op: 'ask', id: aid, session: id });
	assert.ok(mine.some((e) => e.op === 'ask_text'), 'the text streams');
	const done = mine.at(-1);
	assert.equal(done?.op, 'ask_done');
	assert.equal(done?.text, 'It retries `times` times.\nThe count comes back.');
	assert.deepEqual(done?.links, [{ title: 'the loop', target: 'a.ts:11', kind: 'file' }]);
	assert.deepEqual(done?.terms, ['retry']);
	assert.equal(pi.inbox.length, 0, 'a side call, not the conversation');
	assert.ok(existsSync(join(ws, '.symbiosis', 'notes', 'deep')), 'pi made the folder for the note');
	assert.match(pi.asked.at(-1) ?? '', /The function around it, `retry`/, 'the outline of the buffer text');
	assert.match(pi.asked.at(-1) ?? '', /Their question: why a loop\?/);
});

test('an old ask.json is not answered again after a restart; cancel stops the answer', async () => {
	const slow = new FakePi({ cwd: ws, chunk: 2, stepMs: 20, answer: () => REPLY.repeat(3) });
	await pi.stop();
	pi = slow;
	await pi.start();
	id = pi.sessionId() ?? '';
	writeFileSync(join(plugin, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner: id }));
	await sleep(400);
	assert.equal(pi.asked.length, 0, 'the question from before is old');
	const aid = ask();
	await until(() => events().some((e) => e.op === 'ask_text' && e.id === aid), 'the answer starts');
	writeFileSync(join(plugin, 'ask.json'), JSON.stringify({ id: aid, to: id, cancel: true }));
	await until(() => events().some((e) => e.op === 'ask_done' && e.id === aid), 'ask_done after cancel');
	assert.equal(events().find((e) => e.op === 'ask_done' && e.id === aid)?.stopped, true);
});
