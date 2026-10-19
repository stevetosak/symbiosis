// What a demo scenario is. Each scenario shows one feature of symbiosis with a
// scripted pi, so the same thing happens on every run. To add one: write a file
// in this folder that exports a `Scenario`, and list it in ./index.ts.
import type { FakePi } from '../fake-pi.ts';

/** What a scenario's `run` gets: the pi it plays, the workspace, and the demo's voice. */
export interface Kit {
	pi: FakePi;
	/** The workspace copy (an absolute path). */
	dir: string;
	/** A line in the pi tab. */
	say: (line: string) => void;
	/** The time between steps (PAUSE_MS). */
	pause: () => Promise<void>;
	/** True once the operator ended the demo. */
	stopping: () => boolean;
}

/** A headless ttt run that proves the feature (test/e2e/scenarios.sh). */
export interface Check {
	/** The file ttt opens (`name` or `name:line`); default: no file. */
	open?: string;
	/** `ttt --exec` steps, after the scenario's task is done. $SHOT is the screenshot file. */
	drive: string;
	/** Texts the screenshot must hold. */
	expect: string[];
	/** Texts it must not hold. */
	absent?: string[];
}

export interface Scenario {
	/** The word after `npm run demo --`: lower case, no spaces. */
	name: string;
	/** One line for `--list`. */
	title: string;
	/** Two or three sentences: what the feature is and why you would care. */
	about: string;
	/** What you press, and what you should see: one line each. */
	try: string[];
	/** Makes the workspace the way the task found it, before pi starts. */
	prepare?: (dir: string) => void;
	/** The scripted pi's work. It ends when the task ends. */
	run: (kit: Kit) => Promise<void>;
	/** The proof. A scenario with none is covered by another e2e script (`covered`). */
	check?: Check;
	covered?: string;
	/** Keep the scripted pi after the task, for the operator's helpi! questions. */
	answers?: boolean;
}

/**
 * ttt steps that open the plan drawer and wait until pi reached its last plan
 * step: the drawer shows that step's text (the status bar is no sign: pi's
 * notices cover it). The extra wait lets pi's last change land.
 */
export const planReached = (lastStep: string): string => `key ctrl+k v; wait-for "${lastStep}" timeout=60000; wait 2500`;

/** The same, then Esc: the focus goes back to the editor, so an editor key goes to it. */
export const afterTurn = (lastStep: string): string => `${planReached(lastStep)}; key escape`;
