// `symbiosis close [folder] [--keep-editor]`: the other half of `symbiosis`.
// It ends what the command opened:
//
//   1. pi: the session in the pane the launcher made is asked to quit (close.json,
//      `ctx.shutdown()` in pi), and when it has quit, its pane is closed. A pi
//      that did not start from this launcher is not touched.
//   2. ttt: the plugin is asked to quit (quit.json): it quits as ctrl+q does, so
//      ttt asks about running programs and unsaved files. (SIGTERM would drop
//      unsaved text without a word.) `--keep-editor` skips this step: the ttt
//      plugin runs the command that way and quits itself.
//
// Inside ttt (its environment holds SYMBIOSIS_SESSION) the command needs no
// folder: the session names the launcher's process.
import { UsageError } from './args.ts';
import { type Argv, closePane } from './layout.ts';
import { alive, findByPid, findOpen, type Host, type OpenRecord } from './record.ts';
import type { FileChannel } from '../core/channel/file.ts';

export interface CloseArgs {
	folder?: string;
	keepEditor: boolean;
	help: boolean;
}

export const CLOSE_USAGE = `Usage: symbiosis close [folder] [--keep-editor]

Closes what symbiosis opened for the folder: pi quits and its tab or pane
closes, then ttt quits. pi sessions you started yourself stay.

  folder         default: the git root, else this folder; inside ttt: its symbiosis
  --keep-editor  leave ttt open (the ttt plugin runs it this way, then quits itself)
  -h             this text

A folder named "close" is written ./close.`;

export function parseCloseArgs(argv: string[]): CloseArgs {
	const args: CloseArgs = { keepEditor: false, help: false };
	for (const a of argv) {
		if (a === '--keep-editor') args.keepEditor = true;
		else if (a === '-h' || a === '--help') args.help = true;
		else if (a.startsWith('-')) throw new UsageError(`symbiosis close: unknown option ${a}`);
		else if (args.folder !== undefined) throw new UsageError(`symbiosis close: one folder only, got ${args.folder} and ${a}`);
		else args.folder = a;
	}
	return args;
}

/** The launcher's process id in a SYMBIOSIS_SESSION value (`<pid>-<time>`), if it is one. */
export function sessionPid(session: string | undefined): number | undefined {
	const pid = Number(session?.match(/^(\d+)-/)?.[1]);
	return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** How long pi gets to quit before its pane is left alone. */
export const QUIT_WAIT_MS = 8000;

export interface CloseDeps {
	channel: Pick<FileChannel, 'sessions' | 'requestClose' | 'requestQuit'>;
	/** Runs a multiplexer command; throws when it fails. */
	run: (argv: Argv) => void;
	isAlive?: (pid: number) => boolean;
	sleep?: (ms: number) => Promise<void>;
	/** Says what happened, one line at a time. */
	say: (line: string) => void;
	waitMs?: number;
}

export interface Closed {
	/** pi is gone (or was not running), and its pane is closed when there was one. */
	ok: boolean;
}

/** Quits the pi that the launcher started in `record.pi` and closes its pane. */
export async function closePi(record: OpenRecord, deps: CloseDeps): Promise<Closed> {
	const isAlive = deps.isAlive ?? alive;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const host: Host | null = record.host;
	const pane = record.pi ?? null;
	if (!pane || !host) {
		deps.say('symbiosis: no pi pane was made by symbiosis here, so no pi is closed.');
		return { ok: true };
	}
	const session = deps.channel.sessions().find((s) => s.pane === pane && s.host === host.kind && isAlive(s.pid));
	if (!session) {
		deps.say(`symbiosis: pi does not run in ${host.kind} pane ${pane}; the pane stays.`);
		return { ok: true };
	}
	deps.channel.requestClose(session.id);
	const end = Date.now() + (deps.waitMs ?? QUIT_WAIT_MS);
	while (isAlive(session.pid)) {
		if (Date.now() > end) {
			deps.say(`symbiosis: pi (${session.name}) did not quit in ${Math.round((deps.waitMs ?? QUIT_WAIT_MS) / 1000)} s; its ${host.kind} pane ${pane} stays.`);
			return { ok: false };
		}
		await sleep(100);
	}
	try {
		deps.run(closePane(host, pane));
	} catch {
		// The pane is gone already (the shell ended with pi), or the multiplexer is.
	}
	return { ok: true };
}

/** How long ttt gets to quit: it may ask a question first. */
export const EDITOR_WAIT_MS = 10000;

/** Asks the editor to quit and waits for the launcher (which ends with ttt) to end. */
export async function quitEditor(record: OpenRecord, deps: CloseDeps): Promise<Closed> {
	const isAlive = deps.isAlive ?? alive;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const wait = deps.waitMs ?? EDITOR_WAIT_MS;
	deps.channel.requestQuit();
	const end = Date.now() + wait;
	while (isAlive(record.pid)) {
		if (Date.now() > end) {
			deps.say(`symbiosis: ttt of ${record.folder} has not quit: it may ask about unsaved files or running programs. Answer there.`);
			return { ok: false };
		}
		await sleep(100);
	}
	return { ok: true };
}

/** The record this command acts on: the one of this ttt (inside ttt), else the folder's. */
export function target(args: CloseArgs, env: NodeJS.ProcessEnv, states: string, folder: () => string): OpenRecord | undefined {
	const pid = args.folder === undefined ? sessionPid(env.SYMBIOSIS_SESSION) : undefined;
	if (pid !== undefined) {
		const record = findByPid(states, pid);
		if (record) return record;
	}
	return findOpen(states, folder());
}
