// `symbiosis`: ttt in the whole pane, pi working behind it.
//
// One process (decision 4): it starts `pi --mode rpc` in the folder, runs ttt
// as its child on this terminal, passes your prompts and pi's dialogs between
// them (launcher/backend.ts), and stops pi when ttt quits. pi saves its
// session itself, so nothing is left running.
//
// Environment, for tests and unusual installs: SYMBIOSIS_PI and SYMBIOSIS_TTT
// name the pi and ttt commands (default: pi, ttt from PATH).
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { constants } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, USAGE, UsageError } from './args.ts';
import { Backend } from './backend.ts';
import { ConfigError, configPath, readConfig } from './config.ts';
import { projectFolder } from './folder.ts';
import { alreadyOpen, findOpen, hostOf, recordPath, removeRecord, stateDir, writeRecord } from './record.ts';
import { RpcError, RpcPi } from './rpc.ts';
import { pluginDir } from '../pi/stream.ts';

/** How long pi may take to start and answer its first command. */
const START_MS = 30_000;
const TICK_MS = 100;

function fail(message: string, code = 1): never {
	process.stderr.write(`${message}\n`);
	process.exit(code);
}

/** The last lines of pi's log, to show why it did not start. */
function tail(path: string, lines = 15): string {
	try {
		return readFileSync(path, 'utf-8').trimEnd().split('\n').slice(-lines).join('\n');
	} catch {
		return '';
	}
}

/** A child's exit as a shell exit code. */
function exitCode(code: number | null, signal: NodeJS.Signals | null): number {
	if (code !== null) return code;
	const n = signal ? (constants.signals as Record<string, number>)[signal] : undefined;
	return 128 + (n ?? 1);
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
	if (args.tab || config.open === 'tab') {
		process.stderr.write('symbiosis: a new tab is not built yet (it comes with herdr and tmux support); opening here.\n');
	}

	const states = stateDir();
	if (!args.fresh) {
		const open = findOpen(states, folder);
		if (open) fail(alreadyOpen(open));
	}
	const plugin = pluginDir();
	if (!existsSync(plugin)) {
		fail(`symbiosis: the ttt plugin is not installed (${plugin}).\nRun install.sh from the symbiosis repository, or start pi once: it copies the plugin.`);
	}

	const id = `${process.pid}-${Date.now().toString(36)}`;
	const backend = new Backend(join(plugin, 'backends', id));
	const logPath = recordPath(states, folder).replace(/\.json$/, '.log');
	mkdirSync(states, { recursive: true });
	const log = openSync(logPath, 'w');
	const piCommand = process.env.SYMBIOSIS_PI || 'pi';
	const piArgs = ['--mode', 'rpc', ...(args.continue ? ['--continue'] : []), ...config.piArgs, ...args.piArgs];
	const pi = new RpcPi(piCommand, piArgs, { cwd: folder, stderr: log });
	pi.onRecord = (record) => backend.handle(record);
	backend.attach(pi);

	try {
		await pi.request({ type: 'get_state' }, START_MS);
	} catch (error) {
		await pi.close(1000);
		backend.remove();
		closeSync(log);
		const why = error instanceof RpcError ? error.message : String(error);
		const lines = tail(logPath);
		fail(`symbiosis: pi did not start: ${why}\n  ${piCommand} ${piArgs.join(' ')}\n  in ${folder}${lines ? `\n\nIts log (${logPath}):\n${lines}` : ''}`);
	}
	backend.setState('ready');
	let piGone = false;
	void pi.exited.then(({ code, signal }) => {
		piGone = true;
		backend.setState('exited');
		backend.notice(`pi stopped (${signal ?? `code ${code}`}); its log: ${logPath}`, 'error');
	});

	writeRecord(states, { pid: process.pid, folder, started: Date.now(), host: hostOf() });
	const ticker = setInterval(() => backend.tick(), TICK_MS);

	const tttCommand = process.env.SYMBIOSIS_TTT || 'ttt';
	const ttt = spawn(tttCommand, [folder], { cwd: folder, stdio: 'inherit', env: { ...process.env, SYMBIOSIS_BACKEND: id } });
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

	clearInterval(ticker);
	process.off('SIGINT', ignore);
	if (!piGone) await pi.close();
	backend.remove();
	removeRecord(states, folder, process.pid);
	closeSync(log);
	return exitCode(exit.code, exit.signal);
}

main().then(
	(code) => process.exit(code),
	(error: unknown) => fail(`symbiosis: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`),
);
