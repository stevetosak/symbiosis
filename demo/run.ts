// The symbiosis demo: a small task in a to-do app, in a fresh copy of
// demo/workspace, with ttt and pi opened by the symbiosis command.
//
//   npm run demo                the whole flow with the scripted pi: no model, no tokens, the same every time
//   npm run demo -- <name>      one feature (follow, plan, changes, marks, seen, diff, helpi); --<name> also works
//   npm run demo -- --list      the scenarios (demo/scenarios/)
//   npm run demo -- --real      a real pi, given demo/PROMPT.md at once (costs tokens)
//   npm run demo -- --reset     only make a fresh copy
//   npm run demo -- --stubs     stubs and functions from descriptions, with a
//                               real pi that waits for you (demo/STUBS.md)
//
// Other arguments go to the symbiosis command (--split, --tab, -- <pi args>).
// `--show <name>` prints a scenario's headless check as JSON (test/e2e/scenarios.sh).
// The scripted pi is this file with --scripted (demo/scripted-pi): it waits
// until ttt follows it, does the task (plan, a new file, edits, a test), then
// answers your helpi! comments with set answers. See demo/README.md.
//
// DEMO_DIR (default /tmp/symbiosis-demo, /tmp/symbiosis-stubs with --stubs) is the workspace copy; the scripted
// pi uses its working folder when that is a demo copy. PAUSE_MS is the time
// between steps; START_MS the time between "ttt follows" and the first step;
// SUGGEST_MS stops the wait for helpi! (0: until ctrl+c).
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOpen, stateDir } from '../launcher/record.ts';
import { FakePi, sleep } from './fake-pi.ts';
import { helpiAnswer } from './scenarios/helpi.ts';
import { DEFAULT, find, listing } from './scenarios/index.ts';

const TAG = '.symbiosis-demo';
const OURS = ['--scripted', '--real', '--reset', '--stubs', '--list', '--show'];
// `--plan` means the scenario `plan`: a flag is easy to type after `npm run demo --`.
const argv = process.argv.slice(2).map((a) => (a.startsWith('--') && !OURS.includes(a) && find(a.slice(2)) ? a.slice(2) : a));

// A word before `--` that is no flag names a scenario (the scripted pi reads it from the workspace tag file; DEMO_SCENARIO overrides, for tests).
const words = argv.slice(0, argv.includes('--') ? argv.indexOf('--') : argv.length).filter((a) => !a.startsWith('-'));
// The scripted pi runs in a tmux or herdr pane that has not our environment: the workspace says which scenario.
const tagged = (() => {
	try {
		return /^scenario: (\w+)$/m.exec(readFileSync(join(process.cwd(), TAG), 'utf-8'))?.[1];
	} catch {
		return undefined;
	}
})();
const scenarioName = process.env.DEMO_SCENARIO ?? (argv.includes('--scripted') ? tagged : undefined) ?? words[0] ?? DEFAULT;
const scenario = find(scenarioName);
if (words.length > 1 || !scenario) {
	console.error(`${scenario ? `one scenario at a time: ${words.join(' ')}` : `no scenario "${scenarioName}"`}. The scenarios:\n${listing()}`);
	process.exit(2);
}
if (argv.includes('--list')) {
	console.log(`npm run demo -- <name>:\n${listing()}\n  (the stubs demo is another one: npm run demo -- --stubs, see demo/STUBS.md)`);
	process.exit(0);
}
if (argv.includes('--show')) {
	console.log(JSON.stringify(scenario.check ?? null));
	process.exit(0);
}
const scripted = argv.includes('--scripted');
const stubs = argv.includes('--stubs');
const DIR = scripted && existsSync(join(process.cwd(), TAG)) ? process.cwd() : (process.env.DEMO_DIR ?? (stubs ? '/tmp/symbiosis-stubs' : '/tmp/symbiosis-demo'));
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 1500);
const START_MS = Number(process.env.START_MS ?? 3000);
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
	writeFileSync(join(DIR, TAG), `Made by symbiosis demo/run.ts. The demo deletes and copies this folder again.\nscenario: ${scenario?.name}\n`);
	if (!stubs) scenario?.prepare?.(DIR);
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
	else if (real) say('a real pi, given demo/PROMPT.md: it starts at once and costs tokens.');
	else say(`the scripted pi, scenario "${scenario?.name}": no model, no tokens.`);
	process.exit(await launch(real, argv.filter((a, i) => !OURS.includes(a) && !(words.length > 0 && i === argv.indexOf(words[0])))));
}

const sc = scenario!;
const pi = new FakePi({ cwd: DIR, name: 'demo', answer: helpiAnswer, thinkMs: 800, log: (line) => say(`  ${line}`) });
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
say('');
say(`scenario ${sc.name}: ${sc.title}`);
say(sc.about);
say('');
say('Try:');
for (const line of sc.try) say(`  ${line}`);
say('');
say('waiting until ttt follows this session ("π demo" in its status bar) ...');
say(`  (no ttt yet? open it: ttt ${DIR})`);
await pi.waitOwner();
say(`the editor follows "demo". Start in ${Math.round(START_MS / 1000)} s. Other scenarios: npm run demo -- --list`);
await sleep(START_MS);

await sc.run({ pi, dir: DIR, say, pause, stopping: () => stopping });
if (!sc.answers) {
	say('the scenario is over. ctrl+c here, or quit ttt, ends the demo.');
	setInterval(() => {}, 1 << 30);
	await new Promise(() => {});
}
await pi.stop();
