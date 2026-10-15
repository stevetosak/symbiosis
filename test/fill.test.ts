// Stub filling on the pi side, end to end without ttt: the fake pi loads the
// real extension; the test plays the editor by writing its files in the
// plugin folder (ttt.json, fill.json, answer.json) and reading events.jsonl.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const base = mkdtempSync(join(tmpdir(), 'symbiosis-fill-'));
process.env.TTT_CONFIG_DIR = join(base, 'cfg');
const plugin = join(base, 'cfg', 'plugins', 'symbiosis');
const ws = join(base, 'ws');
mkdirSync(plugin, { recursive: true });
mkdirSync(ws);

// After TTT_CONFIG_DIR is set: the extension reads it when it loads.
const { FakePi, sleep } = await import('../demo/fake-pi.ts');

const file = join(ws, 'sample.ts');
const FILL_OLD = "\t// TODO(pi)\n\tthrow new Error('not written');";
const FILL_NEW = "\tconst data = await readFile(path, 'utf8');\n\treturn data.split('\\n').map(Number).reduce((a, b) => a + b, 0);";

let pi: InstanceType<typeof FakePi>;
let id = '';

function editor(state: Record<string, unknown>): void {
	writeFileSync(join(plugin, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner: id, lag: -1, ...state }));
}

const record = () => JSON.parse(readFileSync(join(plugin, 'sessions', `${id}.json`), 'utf-8'));
const events = () =>
	readFileSync(join(plugin, 'events.jsonl'), 'utf-8')
		.trim()
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l));

async function until(check: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 50 && !check(); i++) await sleep(50);
	assert.ok(check(), what);
}

let seq = 0;
async function fill(line: number): Promise<void> {
	const before = pi.inbox.length;
	writeFileSync(join(plugin, 'fill.json'), JSON.stringify({ id: `f${++seq}`, to: id, path: file, line }));
	await until(() => pi.inbox.length > before, 'the fill message reaches the agent');
}

before(async () => {
	copyFileSync(new URL('./fixtures/stubs/sample.ts', import.meta.url), file);
	writeFileSync(join(ws, 'helper.ts'), 'export const helper = (k: string, n: number) => k.length + n;\n');
	pi = new FakePi({ cwd: ws, chunk: 4000, stepMs: 0 });
	await pi.start();
	id = pi.sessionId() ?? '';
	assert.ok(id);
	editor({});
});

after(async () => {
	await pi.stop();
	rmSync(base, { recursive: true, force: true });
});

test('fill! sends the agent the fill message and the record names the stub', async () => {
	await fill(8);
	assert.match(pi.inbox.at(-1) ?? '', /Fill the stub `sumFile` in sample\.ts/);
	assert.deepEqual(record().stub, { path: file, name: 'sumFile', line: 7 });
});

test('inside the body goes through; outside it is blocked and the editor drops it', async () => {
	await pi.beginTurn();
	const outside = await pi.edit(file, [{ oldText: 'const LIMIT = 10;', newText: 'const LIMIT = 20;' }]);
	assert.match(outside.blocked ?? '', /Blocked by symbiosis.*`sumFile`/s);
	assert.match(outside.blocked ?? '', /kind "outside_edit"/);
	assert.match(readFileSync(file, 'utf-8'), /LIMIT = 10/);
	assert.ok(events().some((e) => e.op === 'abort' && /Blocked/.test(e.reason ?? '')), 'an abort with the reason');

	const inside = await pi.edit(file, [{ oldText: FILL_OLD, newText: FILL_NEW }], 'Reads the whole file: the files are small.');
	assert.deepEqual(inside, {});
	const done = events().filter((e) => e.op === 'done').at(-1);
	assert.equal(done?.why, 'Reads the whole file: the files are small.');
	await pi.endTurn();
	// The body is filled: the fill ends.
	assert.equal(record().stub, null);
});

test('a proposal the developer accepts lets that one change through, once', async () => {
	await fill(17);
	await pi.beginTurn();
	const addImport = (to: string) => pi.edit(file, [{ oldText: "import { helper } from './helper.ts';\n", newText: `import { helper } from './helper.ts';\nimport { x } from '${to}';\n` }]);
	const blocked = await addImport('lodash');
	assert.match(blocked.blocked ?? '', /kind "dependency", target "lodash"/);

	const answered = pi.propose({ kind: 'dependency', target: 'lodash', what: 'import lodash', why: 'it has the helper' });
	await until(() => events().some((e) => e.op === 'propose' && e.target === 'lodash'), 'the editor gets the proposal');
	const proposal = events().find((e) => e.op === 'propose');
	writeFileSync(join(plugin, 'answer.json'), JSON.stringify({ id: proposal.id, accept: true, note: 'fine' }));
	assert.match(await answered, /^Accepted: dependency `lodash`, once\. Note from the developer: "fine"\./);
	assert.ok(events().some((e) => e.op === 'propose_end' && e.id === proposal.id));

	assert.deepEqual(await addImport('lodash'), {});
	// Spent: the next new dependency is blocked again.
	assert.ok((await addImport('ramda')).blocked);
	await pi.endTurn();
	// Not filled: the fill stays for the developer's next answer.
	assert.equal(record().stub?.name, 'put');
});

test('a rejected proposal says so, with the note; release ends the fill', async () => {
	const answered = pi.propose({ kind: 'new_file', target: 'util.ts', what: 'a util file', why: 'reuse' });
	await until(() => events().some((e) => e.op === 'propose' && e.kind === 'new_file'), 'the editor gets the proposal');
	const proposal = events().filter((e) => e.op === 'propose').at(-1);
	assert.equal(proposal.target, join(ws, 'util.ts'));
	writeFileSync(join(plugin, 'answer.json'), JSON.stringify({ id: proposal.id, accept: false, note: 'keep it here' }));
	assert.match(await answered, /^Rejected\. Note from the developer: "keep it here"\./);

	writeFileSync(join(plugin, 'fill.json'), JSON.stringify({ id: `f${++seq}`, to: id, release: true }));
	await until(() => record().stub === null, 'release ends the fill');
});

test('with no editor to ask, a proposal is rejected at once', async () => {
	await fill(17);
	editor({ owner: 'someone-else' });
	await sleep(250);
	assert.match(await pi.propose({ kind: 'new_decl', target: 'x', what: 'a const', why: 'y' }), /^Rejected: no one to ask/);
	editor({});
});

test('scope off lets an edit outside the body through', async () => {
	editor({ scope: 'off' });
	await sleep(250);
	await pi.beginTurn();
	assert.deepEqual(await pi.edit(file, [{ oldText: 'const LIMIT = 10;', newText: 'const LIMIT = 11;' }]), {});
	await pi.endTurn();
	editor({});
});

test('fill! on a line with no stub tells the editor', async () => {
	writeFileSync(join(plugin, 'fill.json'), JSON.stringify({ id: `f${++seq}`, to: id, path: file, line: 1 }));
	await until(() => events().some((e) => e.op === 'notice' && /no stub at line 1/.test(e.text)), 'a notice');
});
