// All the run configurations of a workspace folder, in the picker's order:
// Saved (.symbiosis/run.json), VS Code (launch.json, tasks.json), Current
// file, then the detected ones. And a config made ready to start: variables
// expanded, cwd absolute, the environment merged.
import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { type After, commandLine, type Compound, type ListedConfig, parseDotenv, parseRunJson, type RunConfig, RunConfigError } from './config.ts';
import { detect, type WalkOptions } from './detect.ts';
import { CURRENT_FILE_ID, currentFileConfig, fileCommand } from './file.ts';
import { readSmall } from './providers/provider.ts';
import { expand, expandShell, type VariableContext } from './variables.ts';
import { importLaunch, importTasks } from './vscode.ts';

export const RUN_JSON = join('.symbiosis', 'run.json');

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function within(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The workspace folder for a file: the nearest folder above it with a
 * .symbiosis/run.json, up to the git root; else the git root; else `cwd`
 * when the file is in it; else the file's folder. With no file: the git root
 * of `cwd`, else `cwd`.
 */
export function workspaceFolder(file: string | undefined, cwd: string): string {
	const start = file ? dirname(resolve(cwd, file)) : resolve(cwd);
	let git: string | undefined;
	let saved: string | undefined;
	for (let d = start; ; d = dirname(d)) {
		if (!saved && existsSync(join(d, RUN_JSON))) saved = d;
		if (existsSync(join(d, '.git'))) {
			git = d;
			break;
		}
		if (dirname(d) === d) break;
	}
	if (saved) return saved;
	if (git) return git;
	if (!file) return resolve(cwd);
	return within(resolve(cwd), start) ? resolve(cwd) : start;
}

export interface Listing {
	readonly folder: string;
	readonly configs: RunConfig[];
	readonly compounds: Compound[];
	readonly problems: string[];
}

export interface ListOptions extends WalkOptions {
	readonly file?: string;
}

export function listConfigs(folder: string, opts: ListOptions = {}): Listing {
	const configs: RunConfig[] = [];
	const compounds: Compound[] = [];
	const problems: string[] = [];
	const ids = new Set<string>();
	const add = (list: RunConfig[]) => {
		for (const c of list) {
			if (ids.has(c.id)) continue;
			ids.add(c.id);
			configs.push(c);
		}
	};
	const saved = readSmall(join(folder, RUN_JSON));
	if (saved !== undefined) {
		try {
			const file = parseRunJson(saved, RUN_JSON);
			add(file.configs);
			compounds.push(...file.compounds);
		} catch (error) {
			if (!(error instanceof RunConfigError)) throw error;
			problems.push(error.message);
		}
	}
	for (const [file, load] of [['launch.json', importLaunch], ['tasks.json', importTasks]] as const) {
		const text = readSmall(join(folder, '.vscode', file));
		if (text === undefined) continue;
		try {
			const got = load(text, `.vscode/${file}`);
			add(got.configs);
			problems.push(...got.problems);
		} catch (error) {
			if (!(error instanceof RunConfigError)) throw error;
			problems.push(error.message);
		}
	}
	if (opts.file && fileCommand(opts.file)) add([currentFileConfig(opts.file)]);
	const found = detect(folder, opts);
	add(found.configs);
	problems.push(...found.problems);
	return { folder, configs, compounds, problems };
}

/** `picked`: the labels picked last for its inputs. */
export function listed(folder: string, c: RunConfig, file?: string, picked?: string): ListedConfig {
	const cfg = c.id === CURRENT_FILE_ID ? currentFileConfig(file) : c;
	let cwd = cfg.cwd ?? '';
	if (cwd && !cwd.includes('${') && isAbsolute(cwd)) cwd = relative(folder, cwd) || '.';
	return {
		id: c.id, name: c.name, group: c.group, line: commandLine(cfg), cwd: cwd || '.',
		...(c.source ? { source: c.source } : {}),
		...(picked ? { picked } : {}),
	};
}

export function listedCompound(c: Compound, configs: readonly RunConfig[]): ListedConfig {
	const steps = c.steps.map((s) => configs.find((k) => k.id === s.configId)?.name ?? s.configId);
	return {
		id: c.id, name: c.name, group: c.group, kind: 'compound', steps, line: steps.join(' → '), cwd: '.',
		...(c.source ? { source: c.source } : {}),
	};
}

/** What a run starts. */
export interface Launch {
	readonly name: string;
	readonly configId: string;
	readonly folder: string;
	readonly command: string;
	readonly args?: readonly string[];
	readonly cwd: string;
	/** Only the variables the config sets (with envFile); the runner adds them to its own. */
	readonly env: Record<string, string>;
	readonly line: string;
	readonly steps?: readonly { readonly launch: Launch; readonly after?: After }[];
	readonly compound?: string;
}

/** A config ready to start: variables expanded, cwd absolute, envFile read. */
export function resolveConfig(config: RunConfig, ctx: VariableContext): Launch {
	const cfg = config.id === CURRENT_FILE_ID ? currentFileConfig(ctx.file) : config;
	if (cfg.command === '') throw new RunConfigError(ctx.file ? `symbiosis does not know how to run ${ctx.file}` : 'no file is open');
	const x = (s: string) => expand(s, ctx);
	// The current file's command names the file itself: no variables in it
	// (a file may be called a${HOME}.js).
	const literal = config.id === CURRENT_FILE_ID;
	const command = literal ? cfg.command : cfg.args ? x(cfg.command) : expandShell(cfg.command, ctx);
	const args = literal ? cfg.args : cfg.args?.map(x);
	const cwd = resolve(ctx.folder, cfg.cwd ? x(cfg.cwd) : '.');
	if (!isDir(cwd)) throw new RunConfigError(`"${cfg.name}": the folder ${cwd} is not there`);
	const env: Record<string, string> = {};
	if (cfg.envFile) {
		const path = resolve(cwd, x(cfg.envFile));
		const text = readSmall(path);
		if (text === undefined) throw new RunConfigError(`"${cfg.name}": the envFile ${path} is not there`);
		Object.assign(env, parseDotenv(text));
	}
	for (const [k, v] of Object.entries(cfg.env ?? {})) env[k] = x(v);
	return { name: cfg.name, configId: cfg.id, folder: ctx.folder, command, ...(args ? { args } : {}), cwd, env, line: commandLine({ command, args }) };
}
