// ~/.config/symbiosis/config.json. A missing file means the defaults; a
// broken file stops the start with a clear message, so a typo never changes
// what symbiosis does without you knowing.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Open = 'here' | 'tab';
/** tabs: pi in a tab of its own; split: ttt left, pi right in one tab. */
export type Layout = 'tabs' | 'split';

export interface Config {
	/** Where `symbiosis` opens: in this pane, or in a new tab. */
	open: Open;
	/** How ttt and pi sit. */
	layout: Layout;
	/** Arguments pi always gets, before the ones after `--`. */
	piArgs: string[];
}

export const DEFAULTS: Config = { open: 'here', layout: 'tabs', piArgs: [] };

export class ConfigError extends Error {}

export function configPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'symbiosis', 'config.json');
}

/** Reads and checks the file; throws ConfigError with the path and the fault. */
export function readConfig(path: string): Config {
	let text: string;
	try {
		text = readFileSync(path, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS };
		throw new ConfigError(`symbiosis: cannot read ${path}: ${(error as Error).message}`);
	}
	return parseConfig(text, path);
}

export function parseConfig(text: string, path: string): Config {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch (error) {
		throw new ConfigError(`symbiosis: ${path} is not valid JSON: ${(error as Error).message}`);
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ConfigError(`symbiosis: ${path} must hold one JSON object`);
	const config = { ...DEFAULTS };
	for (const [key, value] of Object.entries(raw)) {
		if (key === 'open') {
			if (value !== 'here' && value !== 'tab') throw new ConfigError(`symbiosis: ${path}: "open" must be "here" or "tab", not ${JSON.stringify(value)}`);
			config.open = value;
		} else if (key === 'layout') {
			if (value !== 'tabs' && value !== 'split') throw new ConfigError(`symbiosis: ${path}: "layout" must be "tabs" or "split", not ${JSON.stringify(value)}`);
			config.layout = value;
		} else if (key === 'piArgs') {
			if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) throw new ConfigError(`symbiosis: ${path}: "piArgs" must be a list of strings`);
			config.piArgs = value;
		} else {
			throw new ConfigError(`symbiosis: ${path}: unknown key "${key}" (known: open, layout, piArgs)`);
		}
	}
	return config;
}
