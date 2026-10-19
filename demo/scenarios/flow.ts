// The whole flow, as it was: one task with a plan, a new file and edits, then
// your helpi! questions. `npm run demo` with no name runs it. test/e2e/demo.sh
// drives it end to end.
import { HELPI_HINTS, answerQuestions } from './helpi.ts';
import type { Scenario } from './kit.ts';
import { CLI, FORMAT, play, plan, STEPS, STORE_DONE, TEST } from './task.ts';

const OPS = [FORMAT, STORE_DONE, CLI, TEST];

export const flow: Scenario = {
	name: 'flow',
	title: 'the whole flow: plan, new file, edits, the diff of the turn, helpi!',
	about:
		'A to-do task in four steps. pi plans it with the files each step will change, writes format.ts, edits three files, and then waits for your helpi! questions. Start here to see everything together.',
	try: [
		'ctrl+k v      the plan drawer: each step with its files and changes (Tab goes into it, Enter opens a file)',
		'ctrl+k a      the editor follows pi from now on (it stays where it is by default)',
		'ctrl+k w      the diff of everything pi changed in this turn (ctrl+w closes it)',
		...HELPI_HINTS,
	],
	covered: 'test/e2e/demo.sh',
	run: async (kit) => {
		const { pi, say, pause } = kit;
		await pi.beginTurn();
		say('the plan, with the files of each step (the status bar shows it; ctrl+k v shows all of it)');
		for (let i = 0; i < OPS.length; i++) {
			await pi.plan(...plan(STEPS, i));
			await pause();
			say(`${OPS[i].kind} ${OPS[i].path}`);
			await play(kit, OPS[i]);
			await pause();
		}
		await pi.plan(...plan(STEPS, STEPS.length));
		await pi.endTurn();
		say('turn 1 done. README.md stays "planned": pi named it and did not change it.');
		say('  ctrl+k w: the diff of everything pi changed in this turn (ctrl+w closes it).');
		say('');
		say('Now you:');
		for (const line of HELPI_HINTS) say(line);
		await answerQuestions(kit);
	},
	answers: true,
};
