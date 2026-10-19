// Marks, seen and the exact diff: three scenarios on one task, pi changing
// store.ts in three steps, so the file holds three changes with three colours.
import { afterTurn, type Kit, type Scenario } from './kit.ts';
import { play, plan, STORE_CLEAR, STORE_COUNT, STORE_DONE } from './task.ts';

const STEPS = [
	{ text: 'Add done(id) to the store', files: ['store.ts'] },
	{ text: 'Add count() for the open to-dos', files: ['store.ts'] },
	{ text: 'Add clear() for the finished ones', files: ['store.ts'] },
];
const LAST = 'Add clear() for the finished ones';
const OPS = [STORE_DONE, STORE_COUNT, STORE_CLEAR];

/** pi changes store.ts three times, one change for each step. */
export async function threeEdits(kit: Kit): Promise<void> {
	const { pi, say, pause } = kit;
	await pi.beginTurn();
	for (let i = 0; i < OPS.length; i++) {
		await pi.plan(...plan(STEPS, i));
		await pause();
		say(`step ${i + 1}: edit store.ts`);
		await play(kit, OPS[i]);
		await pause();
	}
	await pi.plan(...plan(STEPS, 3));
	await pi.endTurn();
	say('done: store.ts holds three changes. Open it from the drawer (ctrl+k v, Tab, Enter), or just look at it.');
}

// The lines pi wrote in store.ts: done() from line 18, count() from line 24, clear() from line 32.
const FIRST = 'store.ts:18';

export const marks: Scenario = {
	name: 'marks',
	title: 'marks: the lines pi changed, in the open file',
	about:
		'pi changes store.ts in three steps. In the open file each change has a coloured bar in the gutter (one colour for each step) and a hover text with the step and what pi said it did. If you edit a line, its bar goes and the others keep their place.',
	try: [
		'Open store.ts (ctrl+k v, Tab, Enter on the file row). A `▌` in the gutter marks each line pi wrote',
		'Three steps, three colours. Hover a marked line: the step, `changed`, and pi\'s `why`',
		'Type a character on a marked line: that bar goes, the others stay. Add a line above: the bars move down',
		'Panel (ctrl+k h) → "Changed lines" turns the bars off',
	],
	run: threeEdits,
	check: {
		open: FIRST,
		drive: `${afterTurn(LAST)}; screenshot $SHOT`,
		expect: ['▌18 ', '▌24 ', '▌32 '],
	},
};

export const seen: Scenario = {
	name: 'seen',
	title: 'seen: tell the editor you have read pi\'s changes',
	about:
		'You have read what pi changed, so its bars should leave. One key marks the changes of the open file as seen. In the drawer the same works on one file row or on a whole step. The marks are kept for the pi session.',
	try: [
		'Open store.ts: the bars are there. ctrl+k /      marks the open file\'s changes as seen: the bars go',
		'ctrl+k v, Tab, `s` on a file row or a step row: its changes are seen (`✓ store.ts · 1 change · seen`, muted)',
		'Seen changes stay out of the way when pi changes the file again: only the new change gets a bar',
	],
	run: threeEdits,
	check: {
		open: FIRST,
		drive: `${afterTurn(LAST)}; key ctrl+k /; wait 1500; screenshot $SHOT`,
		expect: ['marked seen'],
		absent: ['▌'],
	},
};

export const diff: Scenario = {
	name: 'diff',
	title: 'diff: the exact change on one line, with pi\'s reason',
	about:
		'A bar tells you pi changed a line, not how. One key opens the exact diff of the change that wrote the line under the cursor, from the text before to the text after, and a notice gives pi\'s reason.',
	try: [
		'Open store.ts, put the cursor on a marked line, then ctrl+k .      the diff of that change opens in a tab (ctrl+w closes it)',
		'A notice says `pi, why: …`: what pi said it did',
		'In the drawer, `d` on a file row opens the diff of the file\'s changes in that step',
	],
	run: threeEdits,
	check: {
		open: FIRST,
		drive: `${afterTurn(LAST)}; key ctrl+k .; wait 1500; screenshot $SHOT`,
		expect: ['store.ts (diff)', 'pi, why: done(id) marks a to-do'],
	},
};
