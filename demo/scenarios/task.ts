// The to-do task as data: what pi writes and edits in demo/workspace. A
// scenario plays the operations through the fake pi (`play`), or puts them on
// disk at once (`applyOnDisk`) when it only needs the result. The edits are
// exact text replacements, as pi's edit tool does them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Edit, StepState } from '../fake-pi.ts';
import type { Kit } from './kit.ts';

export type Op = { kind: 'write'; path: string; content: string; why?: string } | { kind: 'edit'; path: string; edits: Edit[]; why?: string };

export const FORMAT: Op = {
	kind: 'write',
	path: 'format.ts',
	why: 'one to-do as one line, so the CLI and the tests print it the same way',
	content: `// One to-do as one line: "[x] 2 call mum".
import type { Todo } from './store.ts';

export function formatTodo(todo: Todo): string {
	return \`[\${todo.done ? 'x' : ' '}] \${todo.id} \${todo.text}\`;
}
`,
};

export const STORE_DONE: Op = {
	kind: 'edit',
	path: 'store.ts',
	why: 'done(id) marks a to-do and returns it; an unknown id gives undefined',
	edits: [
		{
			oldText: '\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}',
			newText:
				'\tdone(id: number): Todo | undefined {\n\t\tconst todo = this.todos.find((t) => t.id === id);\n\t\tif (todo) todo.done = true;\n\t\treturn todo;\n\t}\n\n\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}',
		},
	],
};

export const STORE_COUNT: Op = {
	kind: 'edit',
	path: 'store.ts',
	why: 'count() lets the CLI say how many to-dos are still open',
	edits: [
		{
			oldText: '\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}',
			newText: '\tcount(): number {\n\t\treturn this.todos.filter((t) => !t.done).length;\n\t}\n\n\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}',
		},
	],
};

export const STORE_CLEAR: Op = {
	kind: 'edit',
	path: 'store.ts',
	why: 'clear() drops the finished to-dos and keeps the ids of the rest',
	edits: [
		{
			oldText: '\t\treturn [...this.todos];\n\t}\n}',
			newText: '\t\treturn [...this.todos];\n\t}\n\n\tclear(): void {\n\t\tthis.todos = this.todos.filter((t) => !t.done);\n\t}\n}',
		},
	],
};

export const CLI: Op = {
	kind: 'edit',
	path: 'cli.ts',
	why: '--done marks the ids after it; each to-do prints with formatTodo',
	edits: [
		{ oldText: '// A small command line: node cli.ts "buy milk" "call mum"', newText: '// A small command line: node cli.ts "buy milk" "call mum" --done 1' },
		{ oldText: "import { Store } from './store.ts';", newText: "import { formatTodo } from './format.ts';\nimport { Store } from './store.ts';" },
		{
			oldText: 'for (const text of process.argv.slice(2)) store.add(text);\nfor (const todo of store.list()) console.log(`${todo.id} ${todo.text}`);',
			newText:
				"const args = process.argv.slice(2);\nconst done: number[] = [];\nfor (let i = 0; i < args.length; i++) {\n\tif (args[i] === '--done') done.push(Number(args[++i]));\n\telse store.add(args[i]);\n}\nfor (const id of done) store.done(id);\nfor (const todo of store.list()) console.log(formatTodo(todo));",
		},
	],
};

export const TEST: Op = {
	kind: 'edit',
	path: 'store.test.ts',
	why: 'one test for done() and for the line formatTodo makes',
	edits: [
		{ oldText: "import { Store } from './store.ts';", newText: "import { formatTodo } from './format.ts';\nimport { Store } from './store.ts';" },
		{
			oldText: "\t\t['buy milk', 'call mum'],\n\t);\n});",
			newText:
				"\t\t['buy milk', 'call mum'],\n\t);\n});\n\ntest('done marks a to-do, and its line shows it', () => {\n\tconst store = new Store();\n\tstore.add('buy milk');\n\tconst todo = store.done(1);\n\tassert.equal(todo?.done, true);\n\tassert.equal(formatTodo(todo), '[x] 1 buy milk');\n\tassert.equal(store.done(7), undefined);\n});",
		},
	],
};

/** The four steps of the task, each with the files pi says it will change. */
export const STEPS: { text: string; files: string[] }[] = [
	{ text: 'Write format.ts: one to-do as one line', files: ['format.ts'] },
	{ text: 'Add done(id) to the store', files: ['store.ts'] },
	{ text: 'Use both in the CLI', files: ['cli.ts', 'README.md'] },
	{ text: 'Test done() and formatTodo()', files: ['store.test.ts'] },
];

/** The plan with `now` steps done, the next one running: the argument list of `pi.plan`. */
export function plan(steps: { text: string; files: string[] }[], now: number): [string, StepState, string[]][] {
	return steps.map((s, i) => [s.text, i < now ? 'done' : i === now ? 'now' : 'next', s.files]);
}

/** pi does one operation. */
export async function play(kit: Kit, op: Op): Promise<void> {
	if (op.kind === 'write') await kit.pi.write(op.path, op.content, op.why);
	else await kit.pi.edit(op.path, op.edits, op.why);
}

/** The result of the operations, on disk at once, with no pi involved. */
export function applyOnDisk(dir: string, ops: Op[]): void {
	for (const op of ops) {
		const file = join(dir, op.path);
		if (op.kind === 'write') {
			writeFileSync(file, op.content);
			continue;
		}
		let text = readFileSync(file, 'utf-8');
		for (const e of op.edits) {
			if (!text.includes(e.oldText)) throw new Error(`demo task: ${op.path} has no text to replace: ${e.oldText.slice(0, 40)}`);
			text = text.replace(e.oldText, () => e.newText);
		}
		writeFileSync(file, text);
	}
}
