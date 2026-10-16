// The symbiosis demo: a small task in a to-do app, in a fresh copy of
// demo/workspace, with ttt and pi opened by the symbiosis command.
//
//   npm run demo                the scripted pi: no model, no tokens, the same every time
//   npm run demo -- --real      a real pi, given demo/PROMPT.md at once (costs tokens)
//   npm run demo -- --reset     only make a fresh copy
//   npm run demo -- --stubs     stubs and functions from descriptions, with a
//                               real pi that waits for you (demo/STUBS.md)
//
// Other arguments go to the symbiosis command (--split, --tab, -- <pi args>).
// The scripted pi is this file with --scripted (demo/scripted-pi): it waits
// until ttt follows it, does the task (plan, a new file, edits, a test), then
// answers your helpi! comments with set answers. See demo/README.md.
//
// DEMO_DIR (default /tmp/symbiosis-demo, /tmp/symbiosis-stubs with --stubs) is the workspace copy; the scripted
// pi uses its working folder when that is a demo copy. PAUSE_MS is the time
// between steps; SUGGEST_MS stops the wait for helpi! (0: until ctrl+c).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOpen, stateDir } from '../launcher/record.ts';
import { FakePi, sleep } from './fake-pi.ts';

const TAG = '.symbiosis-demo';
const OURS = ['--scripted', '--real', '--reset', '--stubs'];
const argv = process.argv.slice(2);
const scripted = argv.includes('--scripted');
const stubs = argv.includes('--stubs');
const DIR = scripted && existsSync(join(process.cwd(), TAG)) ? process.cwd() : (process.env.DEMO_DIR ?? (stubs ? '/tmp/symbiosis-stubs' : '/tmp/symbiosis-demo'));
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 1500);
const SUGGEST_MS = Number(process.env.SUGGEST_MS ?? 0);
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

const say = (line: string) => console.log(`\x1b[2m[demo]\x1b[0m ${line}`);
const pause = () => sleep(PAUSE_MS);

/** A fresh copy of the template. It deletes an old folder only if the demo made it. */
function reset(): void {
	if (existsSync(DIR)) {
		if (!existsSync(join(DIR, TAG))) throw new Error(`${DIR} exists and is not a demo workspace: not deleting it`);
		rmSync(DIR, { recursive: true, force: true });
	}
	cpSync(here(stubs ? './stubs-workspace' : './workspace'), DIR, { recursive: true });
	writeFileSync(join(DIR, TAG), 'Made by symbiosis demo/run.ts. The demo deletes and copies this folder again.\n');
}

/**
 * The symbiosis command on the workspace, with the scripted pi or a real one
 * given PROMPT.md. The stubs demo's real pi gets no prompt: you start each fill.
 */
function launch(real: boolean, rest: string[]): Promise<number> {
	const cut = rest.indexOf('--');
	const flags = cut < 0 ? rest : rest.slice(0, cut);
	const piArgs = cut < 0 ? [] : rest.slice(cut + 1);
	if (stubs) piArgs.push('--name', 'stubs');
	else if (real) piArgs.push('--name', 'demo', `@${here('./PROMPT.md')}`);
	const env = real ? process.env : { ...process.env, SYMBIOSIS_PI: here('./scripted-pi') };
	const args = [...process.execArgv, here('../launcher/main.ts'), DIR, ...flags, ...(piArgs.length ? ['--', ...piArgs] : [])];
	const child = spawn(process.execPath, args, { stdio: 'inherit', env });
	// ttt has the keys in raw mode: ctrl+c is its key, not a signal for us.
	process.on('SIGINT', () => {});
	return new Promise((resolve) => {
		child.on('error', (error) => {
			say(`could not run the symbiosis command: ${error.message}`);
			resolve(1);
		});
		child.on('exit', (code) => resolve(code ?? 1));
	});
}

if (!scripted) {
	// Before the reset: a running demo's files are not pulled away under it.
	const open = findOpen(stateDir(), DIR);
	if (open && !argv.includes('--reset')) {
		const where = open.host ? `in ${open.host.kind} pane ${open.host.pane}` : `as process ${open.pid}`;
		say(`the demo already runs ${where}: quit its ttt first.`);
		process.exit(1);
	}
	reset();
	say(`workspace: ${DIR}`);
	if (argv.includes('--reset')) {
		say(stubs ? 'reset only. Then: npm run demo -- --stubs, and follow demo/STUBS.md.' : 'reset only. A real pi: npm run demo -- --real, or give it demo/PROMPT.md.');
		process.exit(0);
	}
	const real = stubs || argv.includes('--real');
	if (stubs) say('a real pi that waits for you: follow demo/STUBS.md. Each fill costs tokens.');
	else say(real ? 'a real pi, given demo/PROMPT.md: it starts at once and costs tokens.' : 'the scripted pi: no model, no tokens.');
	process.exit(await launch(real, argv.filter((a) => !OURS.includes(a))));
}

// ---- helpi!: the demo's "model" has three set answers, by a word in the question ----
const REMOVE = 'remove(id: number): boolean {\n\tconst before = this.todos.length;\n\tthis.todos = this.todos.filter((t) => t.id !== id);\n\treturn this.todos.length < before;\n}\n';

/** The comment line from the side call's prompt. */
const question = (prompt: string) => /The comment is line \d+:\n(.*)/.exec(prompt)?.[1] ?? '';

function answer(prompt: string): string {
	const q = question(prompt).toLowerCase();
	if (q.includes('test')) return 'ask\n';
	if (q.includes('remove')) return `code\n${REMOVE}`;
	if (q.includes('why') || q.includes('?'))
		return 'note\nlist() returns a copy of the array, so code outside the\nstore cannot add or delete to-dos without add() and done().\n';
	return 'note\nThe demo knows three questions: one with "test" (it asks the main session),\none with "remove" (code), one with "why" (a note).\n';
}

const pi = new FakePi({ cwd: DIR, name: 'demo', answer, thinkMs: 800, log: (line) => say(`  ${line}`) });
let stopping = false;
process.on('SIGINT', async () => {
	if (stopping) process.exit(130);
	stopping = true;
	await pi.stop();
	say('stopped.');
	process.exit(0);
});
await pi.start();

say(`the scripted pi, in ${DIR}`);
// Under the symbiosis command: when its ttt quits, the demo ends too, so an
// old scripted pi does not stay behind for the next run.
if (findOpen(stateDir(), DIR)) {
	const watch = setInterval(async () => {
		if (findOpen(stateDir(), DIR)) return;
		clearInterval(watch);
		say('ttt quit: the demo ends.');
		await pi.stop();
		process.exit(0);
	}, 1000);
	watch.unref();
}
say('waiting until ttt follows this session ("π demo" in its status bar) ...');
say(`  (no ttt yet? open it: ttt ${DIR})`);
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
say('Now you: write a comment that ends in helpi!, and stop typing (or press Enter).');
say('The demo has set answers, by a word in the comment. In store.ts, above list():');
say('  // remove a to-do by id helpi!        code: it takes the place of the comment');
say('  // why does list() copy? helpi!       a note: "pi:" lines under the comment');
say('  // write a test for remove helpi!     ask: it goes to this session, which writes the test');
say('One ctrl+z takes a code answer away again; Esc stops an answer.');

// ---- Then: questions that the answer sent to the main session ("ask") ----
const until = SUGGEST_MS > 0 ? Date.now() + SUGGEST_MS : Infinity;
let answered = 0;
while (Date.now() < until && !stopping) {
	if (pi.inbox.length === 0) {
		await sleep(200);
		continue;
	}
	const message = pi.inbox.splice(0).join('\n');
	say(`pi got this message:\n${message.replace(/^/gm, '    ')}`);
	await pi.beginTurn();
	const hasRemove = readFileSync(join(DIR, 'store.ts'), 'utf-8').includes('remove(id');
	const tested = readFileSync(join(DIR, 'store.test.ts'), 'utf-8').includes("test('remove");
	if (!hasRemove || tested) {
		say(hasRemove ? 'remove() has a test already: nothing to do.' : 'store.ts has no remove(id) yet: ask "remove a to-do by id" first.');
	} else {
		await pi.plan(['Test remove()', 'now']);
		await pause();
		say('edit store.test.ts: a test for remove()');
		await pi.edit('store.test.ts', [
			{
				oldText: "\tassert.equal(store.done(7), undefined);\n});",
				newText:
					"\tassert.equal(store.done(7), undefined);\n});\n\ntest('remove takes a to-do out of the list', () => {\n\tconst store = new Store();\n\tstore.add('buy milk');\n\tassert.equal(store.remove(1), true);\n\tassert.equal(store.remove(1), false);\n\tassert.deepEqual(store.list(), []);\n});",
			},
		]);
		await pi.plan(['Test remove()', 'done']);
	}
	await pi.endTurn();
	answered++;
	say(`done (${answered}). Ask more with helpi!, or ctrl+c to end the demo.`);
}
say(`the demo ends (${answered} turn(s) for your questions).`);
await pi.stop();
