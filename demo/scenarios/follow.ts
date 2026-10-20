// Follow: the editor stays where it is until you turn "follows pi" on; then
// it types each change pi makes as a preview, at the speed you set.
import type { Scenario } from './kit.ts';
import { CLI, FORMAT, play, plan, STEPS, STORE_DONE } from './task.ts';

const OPS = [FORMAT, STORE_DONE, CLI];

export const follow: Scenario = {
	name: 'follow',
	title: 'follow: the editor stays put, or types what pi writes',
	about:
		'pi writes three files, slowly. By default the editor stays on your file and the status bar only says which file pi writes ("not following"). One key turns "follows pi" on: the editor opens each file pi writes and types the change in it as a preview, at the speed you set. pi never waits: when the preview is behind, the bar says by how many changes. Turn it off and pi writes on in the background; on again, and the editor jumps to what pi writes now.',
	try: [
		'Watch the status bar: `pi ✎ format.ts:1 · not following`. Your file stays open.',
		'ctrl+k a      the editor follows pi: it types the change pi writes now, then the next ones',
		'ctrl+k - / =  slower / faster: slow, medium, high, uncapped (`▶ medium · 2 behind`)',
		'ctrl+k space  skip the changes not shown yet: the preview types what pi writes now',
		'ctrl+k a      again: the preview stops, pi writes on in the background (also a click on the π item)',
	],
	run: async (kit) => {
		const { pi, say, pause } = kit;
		await pi.beginTurn();
		for (let i = 0; i < OPS.length; i++) {
			await pi.plan(...plan(STEPS.slice(0, 3), i));
			say(`${OPS[i].kind} ${OPS[i].path} (try ctrl+k a before the next one)`);
			await pause();
			await play(kit, OPS[i]);
			await pause();
			await pause();
		}
		await pi.plan(...plan(STEPS.slice(0, 3), 3));
		await pi.endTurn();
	},
	check: {
		drive: `key ctrl+k a; wait-for "cli.ts ✕" timeout=60000; wait 800; screenshot $SHOT`,
		expect: ['cli.ts ✕'],
	},
};
