// Drives the pi extension with a fake pi (demo/fake-pi.ts), as a model would,
// against the headless ttt of test/e2e/run.sh. Needs TTT_CONFIG_DIR.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakePi, sleep } from '../../demo/fake-pi.ts';
import { pluginDir } from '../../pi/stream.ts';

const dir = process.argv[2];
const pi = new FakePi({
	cwd: dir,
	chunk: Number(process.env.CHUNK ?? 8),
	stepMs: Number(process.env.STEP_MS ?? 25),
	log: (line) => console.log(line),
});
await pi.start();
// The plugin picks this session as the owner within a second or so.
console.log(`owner: ${(await pi.waitOwner(4000)) ? pi.owner() : 'none'}`);
await pi.beginTurn();
const plan = ['Write the to-do store', 'Add done() to the store', 'Note that ids start at 1', 'Run the tests', 'Update the README'];
const at = (now: number) => plan.map((text, i): [string, 'done' | 'now' | 'next'] => [text, i < now ? 'done' : i === now ? 'now' : 'next']);
await pi.plan(...at(0));
await sleep(1200);
await pi.write('todo.ts', readFileSync(new URL('./todo-v1.ts', import.meta.url), 'utf-8'));
await sleep(1500);
await pi.plan(...at(1));
await sleep(1200);
await pi.edit(join(dir, 'todo.ts'), [
	{ oldText: '\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}', newText: '\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}\n\n\tdone(id: number): Todo | undefined {\n\t\tconst todo = this.todos.find((t) => t.id === id);\n\t\tif (todo) todo.done = true;\n\t\treturn todo;\n\t}' },
	{ oldText: '// A to-do list kept in memory.', newText: '// A to-do list kept in memory. Ids start at 1.' },
]);
await pi.plan(...at(3));
// Time for run.sh to open the plan drawer (ctrl+k v) and take a screenshot.
await sleep(Number(process.env.HOLD_MS ?? 0));
await pi.endTurn();
await sleep(300);
// The session record lists the files pi wrote: the editor follows it for them.
const records = readdirSync(join(pluginDir(), 'sessions')).filter((f) => f.endsWith('.json'));
const files: string[] = JSON.parse(readFileSync(join(pluginDir(), 'sessions', records[0]), 'utf-8')).files;
if (files.length === 0) throw new Error('drive: the session record lists no files');
console.log(`drive: session wrote ${files.map((f) => f.slice(f.lastIndexOf('/') + 1)).join(', ')}`);
await pi.stop();
console.log('drive: done');
