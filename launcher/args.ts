// The command line of `symbiosis`:
//
//   symbiosis [folder] [--tab] [-c] [--new] [-- <pi args>]
//
// Pure: no file system, so the tests need nothing.

export interface Args {
	/** The folder as typed; resolved later (launcher/folder.ts). */
	folder?: string;
	/** Open in a new tab of herdr or tmux, for this run. */
	tab: boolean;
	/** Continue pi's last session in this folder (pi --continue). */
	continue: boolean;
	/** Open another one even when symbiosis already runs for the folder. */
	fresh: boolean;
	/** Arguments after `--`, given to pi as they are. */
	piArgs: string[];
	help: boolean;
}

export class UsageError extends Error {}

export const USAGE = `Usage: symbiosis [folder] [--tab] [-c] [--new] [-- <pi args>]

Opens ttt in the folder, with pi working behind it.

  folder      the folder to open; default: the git root, else this folder
  --tab       open in a new tab (herdr or tmux) for this run
  -c          continue pi's last session in the folder
  --new       open another one, also when one already runs for the folder
  -- <args>   give the rest to pi, for example: -- --model sonnet
  -h          this text

Config: ~/.config/symbiosis/config.json  {"open": "here" | "tab", "piArgs": [...]}`;

export function parseArgs(argv: string[]): Args {
	const args: Args = { tab: false, continue: false, fresh: false, piArgs: [], help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') {
			args.piArgs = argv.slice(i + 1);
			break;
		}
		if (a === '--tab') args.tab = true;
		else if (a === '-c' || a === '--continue') args.continue = true;
		else if (a === '--new') args.fresh = true;
		else if (a === '-h' || a === '--help') args.help = true;
		else if (a.startsWith('-')) throw new UsageError(`symbiosis: unknown option ${a}; pi options go after --`);
		else if (args.folder !== undefined) throw new UsageError(`symbiosis: one folder only, got ${args.folder} and ${a}`);
		else args.folder = a;
	}
	return args;
}
