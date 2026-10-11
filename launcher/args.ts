// The command line of `symbiosis`:
//
//   symbiosis [folder] [--tab | --here] [--tabs | --split] [-c] [--new] [-- <pi args>]
//
// Pure: no file system, so the tests need nothing.

import type { Layout } from './config.ts';

export interface Args {
	/** The folder as typed; resolved later (launcher/folder.ts). */
	folder?: string;
	/** Open in a new tab of herdr or tmux, for this run. */
	tab: boolean;
	/** Open in this pane, for this run (wins over the config's "tab"). */
	here: boolean;
	/** How ttt and pi sit, for this run; else the config's. */
	layout?: Layout;
	/** Continue pi's last session in this folder (pi --continue). */
	continue: boolean;
	/** Open another one even when symbiosis already runs for the folder. */
	fresh: boolean;
	/** Arguments after `--`, given to pi as they are. */
	piArgs: string[];
	help: boolean;
}

export class UsageError extends Error {}

export const USAGE = `Usage: symbiosis [folder] [--tab | --here] [--tabs | --split] [-c] [--new] [-- <pi args>]

Opens ttt in the folder and a pi beside it, in herdr or tmux.

  folder      the folder to open; default: the git root, else this folder
  --tab       open in a new tab, not in this pane
  --here      open in this pane
  --tabs      pi in a tab of its own, next to ttt's
  --split     ttt and pi in one tab: ttt left, pi right
  -c          continue pi's last session in the folder
  --new       open another one, also when one already runs for the folder
  -- <args>   give the rest to pi, for example: -- --model sonnet
  -h          this text

Outside herdr and tmux, symbiosis opens ttt only: start pi in another terminal.

Config: ~/.config/symbiosis/config.json
  {"open": "here" | "tab", "layout": "tabs" | "split", "piArgs": [...]}`;

export function parseArgs(argv: string[]): Args {
	const args: Args = { tab: false, here: false, continue: false, fresh: false, piArgs: [], help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') {
			args.piArgs = argv.slice(i + 1);
			break;
		}
		if (a === '--tab') args.tab = true;
		else if (a === '--here') args.here = true;
		else if (a === '--tabs') args.layout = 'tabs';
		else if (a === '--split') args.layout = 'split';
		else if (a === '-c' || a === '--continue') args.continue = true;
		else if (a === '--new') args.fresh = true;
		else if (a === '-h' || a === '--help') args.help = true;
		else if (a.startsWith('-')) throw new UsageError(`symbiosis: unknown option ${a}; pi options go after --`);
		else if (args.folder !== undefined) throw new UsageError(`symbiosis: one folder only, got ${args.folder} and ${a}`);
		else args.folder = a;
	}
	if (args.tab && args.here) throw new UsageError('symbiosis: --tab or --here, not both');
	return args;
}
