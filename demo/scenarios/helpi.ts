// helpi!: you write a comment that ends in helpi! and the "model" answers it,
// by a word in the comment. The finished to-do task is on disk when it starts,
// so the questions have code to ask about.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sleep } from '../fake-pi.ts';
import type { Kit, Scenario } from './kit.ts';
import { applyOnDisk, CLI, FORMAT, STORE_DONE, TEST } from './task.ts';

const REMOVE = 'remove(id: number): boolean {\n\tconst before = this.todos.length;\n\tthis.todos = this.todos.filter((t) => t.id !== id);\n\treturn this.todos.length < before;\n}\n';

/** The comment line from the side call's prompt. */
const question = (prompt: string) => /The comment is line \d+:\n(.*)/.exec(prompt)?.[1] ?? '';

/** The demo's "model": three set answers, by a word in the question. */
export function helpiAnswer(prompt: string): string {
	const q = question(prompt).toLowerCase();
	if (q.includes('test')) return 'ask\n';
	if (q.includes('remove')) return `code\n${REMOVE}`;
	if (q.includes('why') || q.includes('?'))
		return 'note\nlist() returns a copy of the array, so code outside the\nstore cannot add or delete to-dos without add() and done().\n';
	return 'note\nThe demo knows three questions: one with "test" (it asks the main session),\none with "remove" (code), one with "why" (a note).\n';
}

export const HELPI_HINTS = [
	'In store.ts, above list(), write a comment that ends in helpi! and stop typing (or press Enter):',
	'  // remove a to-do by id helpi!        code: it takes the place of the comment',
	'  // why does list() copy? helpi!       a note: "pi:" lines under the comment',
	'  // write a test for remove helpi!     ask: it goes to this session, which writes the test',
	'One ctrl+z takes a code answer away again; Esc stops an answer.',
];

/** Answers the messages the "ask" answer sends to the main session: the demo's turn writes the test. */
export async function answerQuestions(kit: Kit): Promise<void> {
	const { pi, dir, say, pause } = kit;
	const until = Number(process.env.SUGGEST_MS ?? 0) > 0 ? Date.now() + Number(process.env.SUGGEST_MS) : Infinity;
	let answered = 0;
	while (Date.now() < until && !kit.stopping()) {
		if (pi.inbox.length === 0) {
			await sleep(200);
			continue;
		}
		const message = pi.inbox.splice(0).join('\n');
		say(`pi got this message:\n${message.replace(/^/gm, '    ')}`);
		await pi.beginTurn();
		const hasRemove = readFileSync(join(dir, 'store.ts'), 'utf-8').includes('remove(id');
		const tested = readFileSync(join(dir, 'store.test.ts'), 'utf-8').includes("test('remove");
		if (!hasRemove || tested) {
			say(hasRemove ? 'remove() has a test already: nothing to do.' : 'store.ts has no remove(id) yet: ask "remove a to-do by id" first.');
		} else {
			await pi.plan(['Test remove()', 'now', ['store.test.ts']]);
			await pause();
			say('edit store.test.ts: a test for remove()');
			await pi.edit('store.test.ts', [
				{
					oldText: "\tassert.equal(store.done(7), undefined);\n});",
					newText:
						"\tassert.equal(store.done(7), undefined);\n});\n\ntest('remove takes a to-do out of the list', () => {\n\tconst store = new Store();\n\tstore.add('buy milk');\n\tassert.equal(store.remove(1), true);\n\tassert.equal(store.remove(1), false);\n\tassert.deepEqual(store.list(), []);\n});",
				},
			]);
			await pi.plan(['Test remove()', 'done', ['store.test.ts']]);
		}
		await pi.endTurn();
		answered++;
		say(`done (${answered}). Ask more with helpi!, or ctrl+c to end the demo.`);
	}
	say(`the demo ends (${answered} turn(s) for your questions).`);
}

export const helpi: Scenario = {
	name: 'helpi',
	title: 'helpi!: a comment that ends in helpi! gets an answer where you write it',
	about:
		'The to-do task is already done. You write a question as a comment, and the scripted "model" answers it in place: as code, as a note under the comment, or as a message to the main session. Nothing here waits for pi.',
	try: HELPI_HINTS,
	answers: true,
	prepare: (dir) => applyOnDisk(dir, [FORMAT, STORE_DONE, CLI, TEST]),
	run: async (kit) => {
		kit.say('the to-do task is done already. The "model" waits for your questions.');
		await answerQuestions(kit);
	},
	check: {
		open: 'store.ts:17',
		drive: 'wait 3000; key end; key enter; type // why does list() copy? helpi!; key enter; wait 2500; screenshot $SHOT',
		expect: ['// pi: list() returns a copy'],
		absent: ['helpi!'],
	},
};
