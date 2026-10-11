// The symbiosis demo: a scripted pi, no model, no tokens. It resets a copy of
// demo/workspace, waits until ttt follows it, does one small task in the
// to-do app (plan, a new file, edits, a test), then waits for your AI!/AI?
// comments (ctrl+k d) and answers them. See demo/README.md.
//
//   npm run demo             the whole demo
//   npm run demo -- --reset  only reset the workspace (for a real pi: demo/PROMPT.md)
//
// DEMO_DIR (default /tmp/symbiosis-demo) is the workspace copy. PAUSE_MS is the
// time between steps; SUGGEST_MS stops the wait for comments (0: until ctrl+c).
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { findMarkers, type Marker } from '../pi/suggest.ts';
import { type Edit, FakePi, sleep } from './fake-pi.ts';

const DIR = process.env.DEMO_DIR ?? '/tmp/symbiosis-demo';
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 1500);
const SUGGEST_MS = Number(process.env.SUGGEST_MS ?? 0);
const TAG = '.symbiosis-demo';

const say = (line: string) => console.log(`\x1b[2m[demo]\x1b[0m ${line}`);
const pause = () => sleep(PAUSE_MS);

/** A fresh copy of the template. It deletes an old folder only if the demo made it. */
function reset(): void {
	if (existsSync(DIR)) {
		if (!existsSync(join(DIR, TAG))) throw new Error(`${DIR} exists and is not a demo workspace: not deleting it`);
		rmSync(DIR, { recursive: true, force: true });
	}
	cpSync(new URL('./workspace', import.meta.url), DIR, { recursive: true });
	writeFileSync(join(DIR, TAG), 'Made by symbiosis demo/run.ts. The demo deletes and copies this folder again.\n');
}

reset();
say(`workspace: ${DIR}`);
if (process.argv.includes('--reset')) {
	say('reset only. Give a real pi the task in demo/PROMPT.md.');
	process.exit(0);
}

const pi = new FakePi({ cwd: DIR, name: 'demo', log: (line) => say(`  ${line}`) });
let stopping = false;
process.on('SIGINT', async () => {
	if (stopping) process.exit(130);
	stopping = true;
	await pi.stop();
	say('stopped.');
	process.exit(0);
});
await pi.start();

say(`open the workspace in ttt:  ttt ${join(DIR, 'store.ts')}`);
say('waiting until the editor follows this session ("π demo" in the status bar) ...');
await pi.waitOwner();
say('the editor follows "demo". Start in 3 s. Try ctrl+k h (the panel), ctrl+k - / = (speed), ctrl+k space (pause).');
await sleep(3000);

// ---- Turn 1: one task with a plan, a new file and edits ----
const PLAN = ['Write format.ts: one to-do as one line', 'Add done(id) to the store', 'Use both in the CLI', 'Test done() and formatTodo()'];
const steps = (now: number) => PLAN.map((text, i): [string, 'done' | 'now' | 'next'] => [text, i < now ? 'done' : i === now ? 'now' : 'next']);

await pi.beginTurn();
say('turn 1: the plan (the timeline in the status bar; ctrl+k v shows all of it)');
await pi.plan(...steps(0));
await pause();

say('write format.ts: a new file, typed into the editor');
await pi.write(
	'format.ts',
	`// One to-do as one line: "[x] 2 call mum".
import type { Todo } from './store.ts';

export function formatTodo(todo: Todo): string {
	return \`[\${todo.done ? 'x' : ' '}] \${todo.id} \${todo.text}\`;
}
`,
);
await pi.plan(...steps(1));
await pause();

say('edit store.ts: add done(id)');
await pi.edit('store.ts', [
	{
		oldText: '\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}',
		newText:
			'\tdone(id: number): Todo | undefined {\n\t\tconst todo = this.todos.find((t) => t.id === id);\n\t\tif (todo) todo.done = true;\n\t\treturn todo;\n\t}\n\n\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}',
	},
]);
await pi.plan(...steps(2));
await pause();

say('edit cli.ts: three changes in one call');
await pi.edit('cli.ts', [
	{ oldText: '// A small command line: node cli.ts "buy milk" "call mum"', newText: '// A small command line: node cli.ts "buy milk" "call mum" --done 1' },
	{ oldText: "import { Store } from './store.ts';", newText: "import { formatTodo } from './format.ts';\nimport { Store } from './store.ts';" },
	{
		oldText: 'for (const text of process.argv.slice(2)) store.add(text);\nfor (const todo of store.list()) console.log(`${todo.id} ${todo.text}`);',
		newText:
			"const args = process.argv.slice(2);\nconst done: number[] = [];\nfor (let i = 0; i < args.length; i++) {\n\tif (args[i] === '--done') done.push(Number(args[++i]));\n\telse store.add(args[i]);\n}\nfor (const id of done) store.done(id);\nfor (const todo of store.list()) console.log(formatTodo(todo));",
	},
]);
await pi.plan(...steps(3));
await pause();

say('edit store.test.ts: a test for both');
await pi.edit('store.test.ts', [
	{ oldText: "import { Store } from './store.ts';", newText: "import { formatTodo } from './format.ts';\nimport { Store } from './store.ts';" },
	{
		oldText: "\t\t['buy milk', 'call mum'],\n\t);\n});",
		newText:
			"\t\t['buy milk', 'call mum'],\n\t);\n});\n\ntest('done marks a to-do, and its line shows it', () => {\n\tconst store = new Store();\n\tstore.add('buy milk');\n\tconst todo = store.done(1);\n\tassert.equal(todo?.done, true);\n\tassert.equal(formatTodo(todo), '[x] 1 buy milk');\n\tassert.equal(store.done(7), undefined);\n});",
	},
]);
await pi.plan(...PLAN.map((text): [string, 'done'] => [text, 'done']));
await pi.endTurn();
say('turn 1 done. The editor went to the last change.');
say('  ctrl+k w: the diff of everything pi changed in this turn (ctrl+w closes it).');
say('');
say('Now you: write a comment that ends in AI! (or AI?) in any file, for example');
say('  above list() in store.ts:   // add remove(id) AI!');
say('then press ctrl+k d. The demo does not read your note: it always adds remove(id).');

// ---- Then: answer the comments, as often as you send them ----
const removeMethod = '\tremove(id: number): boolean {\n\t\tconst before = this.todos.length;\n\t\tthis.todos = this.todos.filter((t) => t.id !== id);\n\t\treturn this.todos.length < before;\n\t}\n\n';

/** One edit that deletes the marker: the whole comment line, or the comment after the code. */
function unmark(m: Marker): Edit {
	const line = readFileSync(m.path, 'utf-8').split('\n')[m.line - 1];
	if (m.scope !== 'line') return { oldText: `${line}\n`, newText: '' };
	const code = line.slice(0, line.lastIndexOf(m.target) + m.target.length);
	return { oldText: line, newText: code.trimEnd() };
}

const until = SUGGEST_MS > 0 ? Date.now() + SUGGEST_MS : Infinity;
let answered = 0;
while (Date.now() < until && !stopping) {
	if (pi.inbox.length === 0) {
		await sleep(200);
		continue;
	}
	const message = pi.inbox.splice(0).join('\n');
	say(`pi got this message:\n${message.replace(/^/gm, '    ')}`);
	const markers = findMarkers(DIR);
	await pi.beginTurn();
	const store = join(DIR, 'store.ts');
	const addRemove = !readFileSync(store, 'utf-8').includes('remove(id');
	const plan: string[] = ['Delete the markers'];
	if (addRemove) plan.push('Add remove(id) to the store', 'Test remove()');
	const at = (now: number) => plan.map((text, i): [string, 'done' | 'now' | 'next'] => [text, i < now ? 'done' : i === now ? 'now' : 'next']);
	await pi.plan(...at(0));
	await pause();
	for (const m of markers.filter((m) => m.kind === '?')) say(`AI? ${m.note}\n    (a real pi answers in its reply; the demo cannot)`);
	const byFile = new Map<string, Edit[]>();
	for (const m of markers) byFile.set(m.path, [...(byFile.get(m.path) ?? []), unmark(m)]);
	for (const [path, edits] of byFile) {
		say(`edit ${path.slice(DIR.length + 1)}: delete ${edits.length} marker(s)`);
		await pi.edit(path, edits);
	}
	if (addRemove) {
		await pi.plan(...at(1));
		await pause();
		say('edit store.ts: add remove(id)');
		await pi.edit('store.ts', [{ oldText: '\tlist(): Todo[] {', newText: `${removeMethod}\tlist(): Todo[] {` }]);
		await pi.plan(...at(2));
		await pause();
		say('edit store.test.ts: a test for remove()');
		await pi.edit('store.test.ts', [
			{
				oldText: "\tassert.equal(store.done(7), undefined);\n});",
				newText:
					"\tassert.equal(store.done(7), undefined);\n});\n\ntest('remove takes a to-do out of the list', () => {\n\tconst store = new Store();\n\tstore.add('buy milk');\n\tassert.equal(store.remove(1), true);\n\tassert.equal(store.remove(1), false);\n\tassert.deepEqual(store.list(), []);\n});",
			},
		]);
	}
	await pi.plan(...plan.map((text): [string, 'done'] => [text, 'done']));
	await pi.endTurn();
	answered++;
	say(`done (${markers.length} marker(s)). Send more with ctrl+k d, or ctrl+c to end the demo.`);
}
say(`the demo ends (${answered} answer(s)).`);
await pi.stop();
