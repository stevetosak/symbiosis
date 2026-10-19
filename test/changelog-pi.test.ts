// The change log with the real extension and the fake pi: each write and edit
// is logged with the plan step pi worked on, also when the editor is not the
// owner, and a blocked or failed call is not logged.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const base = mkdtempSync(join(tmpdir(), 'symbiosis-log-pi-'));
process.env.TTT_CONFIG_DIR = join(base, 'cfg');
const plugin = join(base, 'cfg', 'plugins', 'symbiosis');
const ws = join(base, 'ws');
mkdirSync(plugin, { recursive: true });
mkdirSync(ws);

const { FakePi } = await import('../demo/fake-pi.ts');

let pi: InstanceType<typeof FakePi>;
let id = '';
const log = () => JSON.parse(readFileSync(join(plugin, 'log', id, 'index.json'), 'utf-8'));

before(async () => {
	pi = new FakePi({ cwd: ws });
	await pi.start();
	id = pi.sessionId() ?? '';
	assert.ok(id);
	// The editor lives, but follows no session: the log is kept all the same.
	writeFileSync(join(plugin, 'ttt.json'), JSON.stringify({ t: Date.now() / 1000 + 3600, owner: 'someone-else' }));
});

after(async () => {
	await pi.stop();
	rmSync(base, { recursive: true, force: true });
});

test('a write and an edit go in the log, each with the step pi worked on', async () => {
	const file = join(ws, 'a.ts');
	await pi.beginTurn();
	await pi.plan(['Write a.ts', 'now'], ['Test it', 'next']);
	await pi.write(file, 'one\ntwo\n', 'a small file');
	await pi.plan(['Write a.ts', 'done'], ['Test it', 'now']);
	await pi.edit(file, [{ oldText: 'two', newText: 'TWO' }]);
	await pi.endTurn();
	const changes = log().changes;
	assert.deepEqual(
		changes.map((c: { tool: string; step: number; stepText: string; created: boolean; why?: string }) => [c.tool, c.step, c.stepText, c.created, c.why]),
		[
			['write', 0, 'Write a.ts', true, 'a small file'],
			['edit', 1, 'Test it', false, undefined],
		],
	);
	assert.deepEqual(changes[1].hunks, [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1 }]);
	const texts = JSON.parse(readFileSync(join(plugin, 'log', id, `${changes[1].id}.json`), 'utf-8'));
	assert.deepEqual(texts, { before: 'one\ntwo\n', after: 'one\nTWO\n' });
});

test('an edit that fails is not logged', async () => {
	const file = join(ws, 'a.ts');
	const count = log().changes.length;
	await pi.beginTurn();
	const result = await pi.edit(file, [{ oldText: 'not in the file', newText: 'x' }]);
	await pi.endTurn();
	assert.ok(result.error, 'pi says the edit failed');
	assert.equal(log().changes.length, count);
});
