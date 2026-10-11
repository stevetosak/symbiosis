// `symbiosis`: ttt in the folder, and a real pi beside it.
//
// In herdr or tmux it starts pi in a pane of its own (launcher/layout.ts):
// by default a tab "pi · <folder>", or with `split` on the right of this pane.
// Then it runs ttt here as its child, and ends when ttt quits. pi stays: it is
// a full pi session in its own pane, to keep talking to or to quit there.
// Outside herdr and tmux it runs ttt only and says how to start pi.
//
// Environment, for tests and unusual installs: SYMBIOSIS_PI and SYMBIOSIS_TTT
// name the pi and ttt commands (default: pi, ttt from PATH).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { constants } from 'node:os';
import { parseArgs, USAGE, UsageError } from './args.ts';
import { ConfigError, configPath, readConfig } from './config.ts';
import { projectFolder } from './folder.ts';
import { type Argv, goTo, herdrPlace, label, newTab, noHost, type PaneStart, paneFromOutput, piCommand, piStart } from './layout.ts';
import { alreadyOpen, findOpen, type Host, hostOf, removeRecord, stateDir, writeRecord } from './record.ts';
import { pluginDir } from '../pi/stream.ts';

function fail(message: string, code = 1): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

/** A child's exit as a shell exit code. */
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
	if (code !== null) return code;
	const n = signal ? (constants.signals as Record<string, number>)[signal] : undefined;
	return 128 + (n ?? 1);
}

/** Runs a multiplexer command; herdr's own binary when herdr names it (in a plugin action). */
function run(argv: Argv): string {
	const bin = argv[0] === 'herdr' && process.env.HERDR_BIN_PATH ? process.env.HERDR_BIN_PATH : argv[0];
	return execFileSync(bin, argv.slice(1), { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Makes the pane and types the command into it; returns the pane id. */
function start(pane: PaneStart): string {
	const id = paneFromOutput(pane.kind, run(pane.create));
	for (const argv of pane.run(id)) run(argv);
	return id;
}

/** Brings the pane of a running symbiosis to the front; false when that fails. */
function goThere(host: Host): boolean {
	try {
		const place = host.kind === 'herdr' ? herdrPlace(run(['herdr', 'pane', 'get', host.pane])) : undefined;
		const steps = goTo(host, place);
		if (steps.length === 0) return false;
		for (const argv of steps) run(argv);
		return true;
	} catch {
		return false;
	}
}

function why(error: unknown): string {
	const e = error as { stderr?: unknown; message?: unknown };
	const stderr = typeof e?.stderr === 'string' ? e.stderr.trim() : '';
	return stderr || (error instanceof Error ? error.message : String(error));
}

async function main(): Promise<number> {
	let args;
	try {
		args = parseArgs(process.argv.slice(2));
	} catch (error) {
		if (error instanceof UsageError) fail(`${error.message}\n\n${USAGE}`, 2);
		throw error;
	}
	if (args.help) {
		process.stdout.write(`${USAGE}\n`);
		return 0;
	}
	let config;
	try {
		config = readConfig(configPath());
	} catch (error) {
		if (error instanceof ConfigError) fail(error.message);
		throw error;
	}
	let folder: string;
	try {
		folder = projectFolder(args.folder, process.cwd());
	} catch (error) {
		if (error instanceof UsageError) fail(error.message, 2);
		throw error;
	}
	const layout = args.layout ?? config.layout;
	const open = args.here ? 'here' : args.tab ? 'tab' : config.open;
	const host: Host | null = hostOf();

	const states = stateDir();
	if (!args.fresh) {
		const found = findOpen(states, folder);
		if (found) {
			if (found.host && goThere(found.host)) {
				process.stderr.write(`symbiosis already runs for ${found.folder}: went to its ${found.host.kind} pane ${found.host.pane}.\n`);
				return 0;
			}
			fail(alreadyOpen(found));
		}
	}
	const plugin = pluginDir();
	if (!existsSync(plugin)) {
		fail(`symbiosis: the ttt plugin is not installed (${plugin}).\nRun install.sh from the symbiosis repository, or start pi once: it copies the plugin.`);
	}
	const pi = piCommand(process.env.SYMBIOSIS_PI || 'pi', args.continue, config.piArgs, args.piArgs);

	if (open === 'tab') {
		if (host) {
			// symbiosis again, in the new tab, with this run's choices.
			const again = [
				process.execPath,
				...process.execArgv,
				process.argv[1],
				folder,
				'--here',
				layout === 'split' ? '--split' : '--tabs',
				...(args.continue ? ['-c'] : []),
				...(args.fresh ? ['--new'] : []),
				...(args.piArgs.length ? ['--', ...args.piArgs] : []),
			];
			try {
				start(newTab(host, folder, label(folder), true, again));
			} catch (error) {
				fail(`symbiosis: could not open a ${host.kind} tab: ${why(error)}`);
			}
			return 0;
		}
		process.stderr.write('symbiosis: a new tab needs herdr or tmux; opening here.\n');
	}

	if (host) {
		try {
			start(piStart(host, layout, folder, pi));
		} catch (error) {
			fail(`symbiosis: could not start pi in a ${host.kind} ${layout === 'split' ? 'pane' : 'tab'}: ${why(error)}`);
		}
	} else {
		process.stderr.write(`${noHost(folder, pi)}\n`);
	}

	writeRecord(states, { pid: process.pid, folder, started: Date.now(), host });
	const tttCommand = process.env.SYMBIOSIS_TTT || 'ttt';
	const ttt = spawn(tttCommand, [folder], { cwd: folder, stdio: 'inherit' });
	// ttt reads the keys in raw mode: ctrl+c is its key, not a signal for us.
	const ignore = () => {};
	process.on('SIGINT', ignore);
	const forward = (signal: NodeJS.Signals) => () => {
		if (ttt.exitCode === null) ttt.kill(signal);
	};
	process.on('SIGTERM', forward('SIGTERM'));
	process.on('SIGHUP', forward('SIGHUP'));

	const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		ttt.on('error', (error) => {
			process.stderr.write(`symbiosis: could not start ${tttCommand}: ${error.message}\n`);
			resolve({ code: 127, signal: null });
		});
		ttt.on('exit', (code, signal) => resolve({ code, signal }));
	});

	process.off('SIGINT', ignore);
	removeRecord(states, folder, process.pid);
	return exitCode(exit.code, exit.signal);
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => fail(`symbiosis: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
);
