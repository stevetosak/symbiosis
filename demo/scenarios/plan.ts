// The plan: steps with the files pi names, moving from next to now to done.
import { planReached, type Scenario } from './kit.ts';
import { CLI, FORMAT, play, plan, STEPS, STORE_DONE, TEST } from './task.ts';

const OPS = [FORMAT, STORE_DONE, CLI, TEST];

export const planScenario: Scenario = {
	name: 'plan',
	title: 'plan: the steps, with the files pi named for each',
	about:
		'pi sends a plan of four steps, each with the files it expects to change, and moves from step to step. The status bar shows the timeline; the drawer shows every step with its files: written, being written, or only planned. The last step stays open here so the drawer shows all rows.',
	try: [
		'The status bar shows the steps: `▶ Add done(id) to the store › Use both in the CLI`',
		'ctrl+k v      the drawer. Tab goes into the list, Up/Down move, Enter on a file opens it',
		'A file marked `· planned` is one pi named and has not reached yet. Done steps fold when you open the drawer late: Enter on a step unfolds it',
	],
	run: async (kit) => {
		const { pi, say, pause } = kit;
		await pi.beginTurn();
		for (let i = 0; i < OPS.length - 1; i++) {
			say(`step ${i + 1}: ${STEPS[i].text}`);
			await pi.plan(...plan(STEPS, i));
			await pause();
			await play(kit, OPS[i]);
			await pause();
		}
		await pi.plan(...plan(STEPS, 3));
		say('the last step is running: the plan stays open, so the drawer shows it.');
		await pi.endTurn();
	},
	check: {
		drive: `${planReached('Test done() and formatTodo()')}; screenshot $SHOT`,
		expect: ['▶ Test done() and formatTodo()', '● format.ts', '● store.ts', '● cli.ts', '· README.md · planned', '· store.test.ts · planned'],
	},
};
