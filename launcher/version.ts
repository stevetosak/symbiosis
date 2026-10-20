// `symbiosis version [--check]`: which symbiosis runs, and whether its parts agree.
//
// Plain it is offline and instant: the package version, the ttt plugin in this
// package against the copy in ttt's plugin folder, and the protocol of the open
// pi sessions. `--check` also asks GitHub for the newest release tag.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileChannel, pluginDir } from '../core/channel/file.ts';
import { PROTOCOL } from '../core/protocol.ts';
import { formatVersion, jsonVersion, luaProtocol, newestTag, VERSION_FILES, type VersionFacts } from '../core/version.ts';
import { UsageError } from './args.ts';

/** The package this launcher belongs to. */
export const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const REPOSITORY = 'https://github.com/stevetosak/symbiosis.git';

export const VERSION_USAGE = `Usage: symbiosis version [--check]

Shows the version of symbiosis, of its ttt plugin, and of the open pi sessions.

  --check   ask GitHub for the newest release (needs the network)
  -h        this text

Update: pi update, then restart pi and run "Plugins: Reload" in ttt.`;

export interface VersionArgs {
	check: boolean;
	help: boolean;
}

export function parseVersionArgs(argv: string[]): VersionArgs {
	const args: VersionArgs = { check: false, help: false };
	for (const a of argv) {
		if (a === '--check') args.check = true;
		else if (a === '-h' || a === '--help') args.help = true;
		else throw new UsageError(`symbiosis version: unknown argument ${a}`);
	}
	return args;
}

export interface VersionDeps {
	root: string;
	/** ttt's plugin folder for symbiosis. */
	plugin: string;
	sessions: () => { name: string; version: number; pid: number }[];
	isAlive: (pid: number) => boolean;
	/** Runs a command and returns its output; throws when it fails. */
	exec: (argv: string[], cwd: string) => string;
	check: boolean;
}

function read(path: string): string | undefined {
	try {
		return existsSync(path) ? readFileSync(path, 'utf-8') : undefined;
	} catch {
		return undefined;
	}
}

/** Gathers the facts; nothing here prints or exits. */
export function gatherFacts(d: VersionDeps): VersionFacts {
	const pkg = read(join(d.root, VERSION_FILES.package));
	const packaged = read(join(d.root, VERSION_FILES.plugin));
	const installed = read(join(d.plugin, 'plugin.ttt.json'));
	const lua = read(join(d.plugin, 'plugin.lua'));
	const facts: VersionFacts = {
		version: pkg ? jsonVersion(pkg) : undefined,
		plugin: { packaged: packaged ? jsonVersion(packaged) : undefined, installed: installed ? jsonVersion(installed) : undefined },
		protocol: {
			packaged: PROTOCOL,
			installed: lua ? luaProtocol(lua) : undefined,
			sessions: d.sessions().filter((s) => d.isAlive(s.pid)).map((s) => ({ name: s.name, version: s.version })),
		},
		checked: d.check,
	};
	// A git clone (pi's copy is one) tells more than the number alone.
	if (existsSync(join(d.root, '.git'))) {
		try {
			facts.describe = d.exec(['git', 'describe', '--tags', '--always'], d.root).trim() || undefined;
		} catch {
			// no git: the number is enough
		}
	}
	if (d.check) {
		try {
			facts.latest = newestTag(d.exec(['git', 'ls-remote', '--tags', REPOSITORY], d.root));
		} catch (error) {
			const e = error as { stderr?: unknown; message?: unknown };
			facts.checkError = (typeof e?.stderr === 'string' && e.stderr.trim()) || (error instanceof Error ? error.message : String(error));
		}
	}
	return facts;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** The command: prints the facts; the exit code is 1 only when --check failed. */
export function versionMain(argv: string[]): number {
	let args: VersionArgs;
	try {
		args = parseVersionArgs(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			process.stderr.write(`${error.message}\n\n${VERSION_USAGE}\n`);
			return 2;
		}
		throw error;
	}
	if (args.help) {
		process.stdout.write(`${VERSION_USAGE}\n`);
		return 0;
	}
	const plugin = pluginDir();
	const channel = new FileChannel(plugin);
	const facts = gatherFacts({
		root: PACKAGE_ROOT,
		plugin,
		sessions: () => channel.sessions().map((s) => ({ name: s.name, version: s.version, pid: s.pid })),
		isAlive: alive,
		exec: (argv, cwd) => execFileSync(argv[0], argv.slice(1), { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 }),
		check: args.check,
	});
	process.stdout.write(`${formatVersion(facts)}\n`);
	return facts.checkError ? 1 : 0;
}
