// Where ttt and pi go, as multiplexer commands. Pure: it only builds the
// command lines and reads their output, so the tests need no herdr or tmux.
//
//   layout tabs   ttt here, pi in a new tab "pi · <folder>" (the default)
//   layout split  this pane splits: ttt left, pi right
//   open tab      first a new tab "<folder>", where symbiosis runs again with --here
//
// Measured with herdr 0.9.3: `tab create` prints the new tab's root pane at
// .result.root_pane.pane_id, `pane split` the new pane at .result.pane.pane_id;
// `pane run` types a command into that pane's shell. tmux prints the pane id
// with -P -F '#{pane_id}'. The shell stays after pi quits, so its last words
// can be read.
import { basename } from 'node:path';
import type { Layout } from './config.ts';
import type { Host } from './record.ts';

/** One command line: the binary and its arguments. */
export type Argv = string[];

/** A new pane, then a command typed into it. */
export interface PaneStart {
	/** Makes the pane and prints its id. */
	create: Argv;
	/** Types `command` into the pane and presses Enter. */
	run: (pane: string) => Argv[];
	kind: Host['kind'];
}

/** Quotes one word for a POSIX shell. */
export function shellQuote(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function shellLine(argv: Argv): string {
	return argv.map(shellQuote).join(' ');
}

/** The tab label for the folder. */
export function label(folder: string, prefix?: string): string {
	const name = basename(folder) || folder;
	return prefix ? `${prefix} · ${name}` : name;
}

/** The herdr workspace of a pane id such as "w4:p1". */
export function workspaceOf(pane: string): string | undefined {
	return pane.match(/^(w[^:]+):/)?.[1];
}

function runIn(kind: Host['kind'], command: Argv): (pane: string) => Argv[] {
	const line = shellLine(command);
	if (kind === 'herdr') return (pane) => [['herdr', 'pane', 'run', pane, line]];
	return (pane) => [
		['tmux', 'send-keys', '-t', pane, '-l', line],
		['tmux', 'send-keys', '-t', pane, 'Enter'],
	];
}

/** A new tab in the folder, running `command`. */
export function newTab(host: Host, folder: string, tabLabel: string, focus: boolean, command: Argv): PaneStart {
	let create: Argv;
	if (host.kind === 'herdr') {
		const workspace = workspaceOf(host.pane);
		create = ['herdr', 'tab', 'create', ...(workspace ? ['--workspace', workspace] : []), '--cwd', folder, '--label', tabLabel, ...(focus ? ['--focus'] : [])];
	} else {
		// No -t: a pane id as the target means its window's index, which is taken.
		create = ['tmux', 'new-window', ...(focus ? [] : ['-d']), '-P', '-F', '#{pane_id}', '-c', folder, '-n', tabLabel];
	}
	return { create, run: runIn(host.kind, command), kind: host.kind };
}

/** This pane splits: the new pane on the right runs `command`; the focus stays here. */
export function splitRight(host: Host, folder: string, command: Argv): PaneStart {
	const create =
		host.kind === 'herdr'
			? ['herdr', 'pane', 'split', host.pane, '--direction', 'right', '--cwd', folder, '--no-focus']
			: ['tmux', 'split-window', '-h', '-d', '-P', '-F', '#{pane_id}', '-t', host.pane, '-c', folder];
	return { create, run: runIn(host.kind, command), kind: host.kind };
}

/** Where pi starts for `layout`, next to the ttt in `host`'s pane. */
export function piStart(host: Host, layout: Layout, folder: string, pi: Argv): PaneStart {
	return layout === 'split' ? splitRight(host, folder, pi) : newTab(host, folder, label(folder, 'pi'), false, pi);
}

/** The new pane's id from the output of `create`; throws when it is not there. */
export function paneFromOutput(kind: Host['kind'], stdout: string): string {
	if (kind === 'tmux') {
		const pane = stdout.trim().split('\n').pop()?.trim();
		if (pane && /^%\d+$/.test(pane)) return pane;
		throw new Error(`tmux did not print a pane id: ${stdout.trim() || '(nothing)'}`);
	}
	let json: { result?: { root_pane?: { pane_id?: unknown }; pane?: { pane_id?: unknown } }; error?: { message?: unknown } };
	try {
		json = JSON.parse(stdout);
	} catch {
		throw new Error(`herdr did not answer in JSON: ${stdout.trim() || '(nothing)'}`);
	}
	const pane = json.result?.root_pane?.pane_id ?? json.result?.pane?.pane_id;
	if (typeof pane === 'string' && pane) return pane;
	throw new Error(`herdr gave no pane: ${typeof json.error?.message === 'string' ? json.error.message : stdout.trim()}`);
}

/** The pi command line: -c continues, then the config's args, then the ones after `--`. */
export function piCommand(pi: string, cont: boolean, configArgs: string[], args: string[]): Argv {
	return [pi, ...(cont ? ['--continue'] : []), ...configArgs, ...args];
}

/** What to say when no multiplexer can hold pi. */
export function noHost(folder: string, pi: Argv): string {
	return `symbiosis: not in herdr or tmux, so this opens ttt only. Start pi in another terminal:\n  cd ${shellQuote(folder)} && ${shellLine(pi)}`;
}
