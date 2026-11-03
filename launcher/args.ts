// The command line of `symbiosis`:
//
//   symbiosis [folder] [--agent pi|claude] [--tab | --here] [--tabs | --split] [-c] [--new] [-- <agent args>]
//   symbiosis close [folder] [--keep-editor]     (launcher/close.ts)
//   symbiosis version [--check]                  (launcher/version.ts)
//
// Pure: no file system, so the tests need nothing.

import { AGENTS, type AgentName, isAgent, type Layout } from './config.ts';

export interface Args {
	/** The folder as typed; resolved later (launcher/folder.ts). */
	folder?: string;
	/** Open in a new tab of herdr or tmux, for this run. */
	tab: boolean;
	/** Open in this pane, for this run (wins over the config's "tab"). */
	here: boolean;
	/** How ttt and the agent sit, for this run; else the config's. */
	layout?: Layout;
	agent?: AgentName;
	/** Continue the agent's last session in this folder (--continue). */
	continue: boolean;
	/** Open another one even when symbiosis already runs for the folder. */
	fresh: boolean;
	/** Arguments after `--`, given to the agent as they are. */
	agentArgs: string[];
	help: boolean;
}

export class UsageError extends Error {}

export const USAGE = `Usage: symbiosis [folder] [--agent pi|claude] [--tab | --here] [--tabs | --split] [-c] [--new] [-- <agent args>]

Opens ttt in the folder and an agent beside it, in herdr or tmux.

  folder      the folder to open; default: the git root, else this folder
  --agent     pi (the default) or claude (Claude Code)
  --tab       open in a new tab, not in this pane
  --here      open in this pane
  --tabs      the agent in a tab of its own, next to ttt's
  --split     ttt and the agent in one tab: ttt left, the agent right
  -c          continue the agent's last session in the folder
  --new       open another one, also when one already runs for the folder
  -- <args>   give the rest to the agent, for example: -- --model sonnet
  -h          this text

Outside herdr and tmux, symbiosis opens ttt only: start the agent in another terminal.

Close it again: symbiosis close [folder]  (the agent quits and its tab closes, then ttt quits)

Version and update check: symbiosis version [--check]  (a folder named "version", "close" or "run" is written ./version)

Run configurations (for the ttt plugin, F5): symbiosis run list|start|again|stop|ps|keep|save

Config: ~/.config/symbiosis/config.json
  {"open": "here" | "tab", "layout": "tabs" | "split", "agent": "pi" | "claude", "agentArgs": [...]}
  agentArgs go to the config's agent only, not to another one named by --agent.`;

export function parseArgs(argv: string[]): Args {
	const args: Args = { tab: false, here: false, continue: false, fresh: false, agentArgs: [], help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--') {
			args.agentArgs = argv.slice(i + 1);
			break;
		}
		if (a === '--agent' || a.startsWith('--agent=')) {
			const name = a === '--agent' ? argv[++i] : a.slice('--agent='.length);
			if (!isAgent(name)) throw new UsageError(`symbiosis: --agent must be ${AGENTS.join(' or ')}, not ${name === undefined ? 'nothing' : JSON.stringify(name)}`);
			args.agent = name;
		} else if (a === '--tab') args.tab = true;
		else if (a === '--here') args.here = true;
		else if (a === '--tabs') args.layout = 'tabs';
		else if (a === '--split') args.layout = 'split';
		else if (a === '-c' || a === '--continue') args.continue = true;
		else if (a === '--new') args.fresh = true;
		else if (a === '-h' || a === '--help') args.help = true;
		else if (a.startsWith('-')) throw new UsageError(`symbiosis: unknown option ${a}; agent options go after --`);
		else if (args.folder !== undefined) throw new UsageError(`symbiosis: one folder only, got ${args.folder} and ${a}`);
		else args.folder = a;
	}
	if (args.tab && args.here) throw new UsageError('symbiosis: --tab or --here, not both');
	return args;
}
