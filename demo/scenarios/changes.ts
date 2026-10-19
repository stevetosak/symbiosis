// The change list: what pi changed, under the step that changed it.
import { planReached, type Scenario } from './kit.ts';
import { CLI, FORMAT, play, plan, STEPS, STORE_COUNT, STORE_DONE, TEST, type Op } from './task.ts';

/** A file no step named. */
const SCRATCH: Op = {
	kind: 'write',
	path: 'scratch.ts',
	why: 'a place to try the output by hand',
	content: "import { Store } from './store.ts';\n\nconst store = new Store();\nstore.add('try it');\nconsole.log(store.list());\n",
};

/** Step by step; some steps also change a file they did not name. */
const WORK: Op[][] = [[FORMAT], [STORE_DONE, SCRATCH], [CLI], [TEST, STORE_COUNT]];

export const changes: Scenario = {
	name: 'changes',
	title: 'changes: the files pi changed, under the plan step of each',
	about:
		'pi works through four steps and some of its changes are not what it planned: one file no step named, one file changed in two steps, one file it named and never touched. The drawer sorts them: changed, new, unplanned, planned.',
	try: [
		'ctrl+k v      the drawer. Under each step: ● changed, ✎ pi is writing it now, · planned',
		'`new` is a file pi made; `unplanned` is a change the step did not name (scratch.ts; store.ts in the last step)',
		'`· README.md · planned`: the CLI step named it and pi never changed it',
		'Tab, Down, Enter on a file opens it at pi\'s first change; the done steps are folded (Enter unfolds a step)',
	],
	run: async (kit) => {
		const { pi, say, pause } = kit;
		await pi.beginTurn();
		for (let i = 0; i < WORK.length; i++) {
			await pi.plan(...plan(STEPS, i));
			await pause();
			for (const op of WORK[i]) {
				say(`step ${i + 1}: ${op.kind} ${op.path}`);
				await play(kit, op);
				await pause();
			}
		}
		await pi.plan(...plan(STEPS, 3));
		await pi.endTurn();
	},
	check: {
		drive: `${planReached('Test done() and formatTodo()')}; screenshot $SHOT`,
		expect: ['● format.ts · new', '● scratch.ts · new · unplanned', '· README.md · planned', '● store.ts'],
	},
};
