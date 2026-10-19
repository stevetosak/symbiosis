// Filling on the pi side (a stub, or a new function under its description), end to end without ttt: the fake pi loads the
// real extension; the test plays the editor by writing its files in the
// plugin folder (ttt.json, fill.json, answer.json) and reading events.jsonl.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
	writeFileSync(join(plugin, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner: id, ...state }));
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
/** Writes the editor's fill request; the agent gets a message, or the editor a notice. */
function request(line: number, mode: 'stub' | 'function' = 'stub', path = file): void {
	writeFileSync(join(plugin, 'fill.json'), JSON.stringify({ id: `f${++seq}`, to: id, mode, path, line }));
}

async function fill(line: number, mode: 'stub' | 'function' = 'stub', path = file): Promise<void> {
	const before = pi.inbox.length;
	request(line, mode, path);
	await until(() => pi.inbox.length > before, 'the fill message reaches the agent');
}

before(async () => {
	copyFileSync(new URL('./fixtures/stubs/sample.ts', import.meta.url), file);
	writeFileSync(join(ws, 'helper.ts'), 'export const helper = (k: string, n: number) => k.length + n;\n');
	pi = new FakePi({ cwd: ws });
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
	assert.deepEqual(record().fill, { kind: 'stub', path: file, name: 'sumFile', line: 7 });
});

test('inside the body goes through; outside it is blocked and the editor hears nothing of it', async () => {
	await pi.beginTurn();
	const outside = await pi.edit(file, [{ oldText: 'const LIMIT = 10;', newText: 'const LIMIT = 20;' }]);
	assert.match(outside.blocked ?? '', /Blocked by symbiosis.*`sumFile`/s);
	assert.match(outside.blocked ?? '', /kind "outside_edit"/);
	assert.match(readFileSync(file, 'utf-8'), /LIMIT = 10/);
	assert.ok(!events().some((e) => e.op === 'start'), 'a blocked call is not told to the editor');

	const inside = await pi.edit(file, [{ oldText: FILL_OLD, newText: FILL_NEW }], 'Reads the whole file: the files are small.');
	assert.deepEqual(inside, {});
	assert.equal(events().filter((e) => e.op === 'start').length, 1, 'the call that ran is told to the editor');
	const done = events().filter((e) => e.op === 'done').at(-1);
	assert.equal(done?.why, 'Reads the whole file: the files are small.');
	await pi.endTurn();
	// The body is filled: the fill ends.
	assert.equal(record().fill, null);
});

test('the filled body lands in the record, with the reasons, until the developer acks it', async () => {
	const [landed, ...rest] = record().review;
	assert.equal(rest.length, 0);
	assert.equal(landed.name, 'sumFile');
	assert.equal(landed.path, file);
	assert.equal(landed.intent, 'Sum the numbers in a file, one per line.');
	assert.match(landed.body, /^const data = await readFile\(path, 'utf8'\);\nreturn data\.split/);
	assert.deepEqual(landed.whys, ['Reads the whole file: the files are small.']);
	// Another session's ack, and an old id, change nothing.
	writeFileSync(join(plugin, 'review.json'), JSON.stringify({ id: 'r0', to: 'other', ack: landed.id }));
	await sleep(250);
	assert.equal(record().review.length, 1);
	writeFileSync(join(plugin, 'review.json'), JSON.stringify({ id: 'r1', to: id, ack: landed.id }));
	await until(() => record().review.length === 0, 'the ack removes the body');
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

	const before = readFileSync(file, 'utf-8');
	assert.deepEqual(await addImport('lodash'), {});
	// Spent: the same change, once more, is blocked again.
	writeFileSync(file, before);
	assert.match((await addImport('lodash')).blocked ?? '', /kind "dependency", target "lodash"/);
	await pi.endTurn();
	// Not filled: the fill stays for the developer's next answer.
	assert.equal(record().fill?.name, 'put');
});

test('another tool (bash) that changes the stub\'s file is undone; other work stands', async () => {
	assert.equal(record().fill?.name, 'put', 'the fill from the test before');
	const before = readFileSync(file, 'utf-8');
	const undone = await pi.other('bash', () => writeFileSync(file, before.replace('const LIMIT = 10;', 'const LIMIT = 99;')));
	assert.match(undone, /^ran\nsymbiosis undid this call's change to sample\.ts: you are filling the stub `put` there\./);
	assert.equal(readFileSync(file, 'utf-8'), before);
	const other = join(dirname(file), 'notes.txt');
	assert.equal(await pi.other('bash', () => writeFileSync(other, 'x')), 'ran', 'another file is not watched');
});

test('a rejected proposal says so, with the note; release ends the fill', async () => {
	const answered = pi.propose({ kind: 'new_file', target: 'util.ts', what: 'a util file', why: 'reuse' });
	await until(() => events().some((e) => e.op === 'propose' && e.kind === 'new_file'), 'the editor gets the proposal');
	const proposal = events().filter((e) => e.op === 'propose').at(-1);
	assert.equal(proposal.target, join(ws, 'util.ts'));
	writeFileSync(join(plugin, 'answer.json'), JSON.stringify({ id: proposal.id, accept: false, note: 'keep it here' }));
	assert.match(await answered, /^Rejected\. Note from the developer: "keep it here"\./);

	writeFileSync(join(plugin, 'fill.json'), JSON.stringify({ id: `f${++seq}`, to: id, release: true }));
	await until(() => record().fill === null, 'release ends the fill');
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
	// The extension reads ttt.json at most every 200 ms.
	await sleep(250);
});

test('fill! on a line with no stub tells the editor', async () => {
	writeFileSync(join(plugin, 'fill.json'), JSON.stringify({ id: `f${++seq}`, to: id, path: file, line: 1 }));
	await until(() => events().some((e) => e.op === 'notice' && /no stub at line 1/.test(e.text)), 'a notice');
});

const described = join(ws, 'described.ts');
const DESCRIBED = `import { helper } from './helper.ts';

const LIMIT = 10;

// a function that clamps n between 0 and LIMIT
// and adds the helper's count for the key

/** Already there. */
export function other(): number {
\treturn 1;
}
`;
const CLAMP = "export function clamp(key: string, n: number): number {\n\treturn Math.min(LIMIT, Math.max(0, n)) + helper(key, 0);\n}\n";
const DESCRIPTION_END = "// and adds the helper's count for the key\n";

test('a function from its description: one new function under it, nothing else', async () => {
	writeFileSync(described, DESCRIBED);
	await fill(6, 'function', described);
	assert.match(pi.inbox.at(-1) ?? '', /Write a new function in described\.ts, directly under the description at line 5-6:/);
	assert.deepEqual(record().fill, { kind: 'place', path: described, name: 'a function that clamps n between 0 and …', line: 5 });

	await pi.beginTurn();
	const helperToo = await pi.edit(described, [
		{ oldText: DESCRIPTION_END, newText: `${DESCRIPTION_END}${CLAMP}` },
		{ oldText: '/** Already there. */', newText: 'const twice = (n: number) => n * 2;\n\n/** Already there. */' },
	]);
	assert.match(helperToo.blocked ?? '', /you are writing the new function under the description at line 5/);
	assert.match(helperToo.blocked ?? '', /kind "new_decl", target "twice"/);

	const apart = await pi.edit(described, [{ oldText: DESCRIPTION_END, newText: `${DESCRIPTION_END}\n${CLAMP}` }]);
	assert.match(apart.blocked ?? '', /new declaration `clamp` that is not directly under the description/);

	assert.deepEqual(await pi.edit(described, [{ oldText: DESCRIPTION_END, newText: `${DESCRIPTION_END}${CLAMP}` }], 'Clamps first.'), {});
	assert.equal(record().fill?.name, 'clamp', 'the record names the new function');
	// Its body may change again; the description may not.
	assert.deepEqual(await pi.edit(described, [{ oldText: '+ helper(key, 0)', newText: '+ helper(key, 1)' }]), {});
	const reworded = await pi.edit(described, [{ oldText: 'clamps n', newText: 'limits n' }]);
	assert.match(reworded.blocked ?? '', /changes or removes the description/);
	await pi.endTurn();
	assert.equal(record().fill, null, 'the function is there: the fill ends');
});

test('a function needs a free place: not under a comment that is already a function\'s', async () => {
	writeFileSync(described, DESCRIBED);
	request(8, 'function', described);
	await until(() => events().some((e) => e.op === 'notice' && /is the comment of `other`: leave a blank line under it/.test(e.text)), 'a notice');
	request(10, 'function', described);
	await until(() => events().some((e) => e.op === 'notice' && /no comment at line 10/.test(e.text)), 'a notice');
});
