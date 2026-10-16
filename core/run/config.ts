// Run configurations: what a run starts. One shape for all of them: the ones
// saved in .symbiosis/run.json, the ones imported from .vscode, and the ones
// detected from the project's files (core/run/providers).
//
// .symbiosis/run.json (comments and trailing commas are allowed):
//
//   { "configurations": [
//     { "name": "api", "command": "npm", "args": ["run", "dev"],
//       "cwd": "${workspaceFolder}/api", "env": { "PORT": "3000" }, "envFile": ".env" },
//     { "name": "worker", "command": "python worker.py --verbose" }
//   ]}
//
// `command` with `args` runs the program directly; `command` alone is a
// shell line (sh -c). Strings take VSCode's variables (core/run/variables.ts).
//
// Inputs, as VSCode's: values a run asks for when it starts. A configuration
// names one with ${input:id} in any of its strings; the options are a list,
// or what a command prints (core/run/inputs.ts runs it and picks):
//
//   { "inputs": [
//       { "id": "device", "type": "pick", "description": "Android device",
//         "command": "node .symbiosis/devices.mjs list android" },
//       { "id": "mode", "type": "pick", "options": ["Debug", { "value": "Release", "detail": "slow" }] }
//     ],
//     "configurations": [{ "name": "app", "command": "run-on ${input:device} ${input:mode}" }] }

/** A configuration, ready to resolve and start. */
export interface RunConfig {
	/** Stable across lists: "saved:api", "npm:web/dev", "file". The runner finds a config by it. */
	readonly id: string;
	readonly name: string;
	/** Where it comes from, for the picker: "Saved", "VS Code", "npm", "Cargo", ... */
	readonly group: string;
	/** The program, or a shell line when `args` is absent. */
	readonly command: string;
	readonly args?: readonly string[];
	/** Absolute, or relative to the workspace folder. Default: the workspace folder. */
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	/** A dotenv file, relative to cwd. */
	readonly envFile?: string;
	/** The file it was read from, relative to the workspace folder. */
	readonly source?: string;
	/** The inputs its strings name (${input:id}), in the order they come. */
	readonly inputs?: readonly InputDef[];
}

/** What the plugin shows: a config with its command as one line. */
export interface ListedConfig {
	readonly id: string;
	readonly name: string;
	readonly group: string;
	readonly line: string;
	readonly cwd: string;
	readonly source?: string;
	/** The labels picked last for its inputs, ", " between them. */
	readonly picked?: string;
}

export class RunConfigError extends Error {}

// Inputs ----------------------------------------------------------------------------

export interface InputOption {
	readonly value: string;
	readonly label: string;
	readonly detail?: string;
	readonly ready?: boolean;
}

export interface InputDef {
	readonly id: string;
	/** What it asks for, in the picker's title. Default: the id. */
	readonly description: string;
	/** The options as they are, or a program that prints them. */
	readonly options?: readonly InputOption[];
	readonly command?: string;
	readonly args?: readonly string[];
}

/** VSCode calls a fixed list "pickString"; here a command may make the list. */
const PICK_TYPES = new Set(['pick', 'pickString']);
const INPUT_REF = /\$\{input:([^}]*)\}/g;

function option(raw: unknown, at: string): InputOption {
	if (typeof raw === 'string') return { value: raw, label: raw };
	const o = raw as Record<string, unknown>;
	if (typeof o !== 'object' || o === null || typeof o.value !== 'string' || o.value === '') throw new RunConfigError(`${at} needs a "value"`);
	for (const key of ['label', 'detail'] as const) {
		if (o[key] !== undefined && typeof o[key] !== 'string') throw new RunConfigError(`${at}.${key} must be a string`);
	}
	return {
		value: o.value,
		label: (o.label as string | undefined) || o.value,
		...(o.detail ? { detail: o.detail as string } : {}),
		...(o.ready === true ? { ready: true } : {}),
	};
}

/** A list of options: run.json's "options", or what a command printed. */
export function parseOptions(raw: unknown, at: string): InputOption[] {
	if (!Array.isArray(raw)) throw new RunConfigError(`${at} must be a list`);
	const seen = new Set<string>();
	return raw.map((r, i) => {
		const o = option(r, `${at}[${i}]`);
		if (seen.has(o.value)) throw new RunConfigError(`${at}: the value "${o.value}" is there twice`);
		seen.add(o.value);
		return o;
	});
}

/** run.json's "inputs" → their definitions, by id. */
export function parseInputs(raw: unknown, where: string): Map<string, InputDef> {
	const defs = new Map<string, InputDef>();
	if (raw === undefined) return defs;
	if (!Array.isArray(raw)) throw new RunConfigError(`${where}: "inputs" must be a list`);
	raw.forEach((r: unknown, i: number) => {
		const d = r as Record<string, unknown>;
		const at = `${where}: inputs[${i}]`;
		if (typeof d !== 'object' || d === null) throw new RunConfigError(`${at} must be an object`);
		if (typeof d.id !== 'string' || !/^[\w.-]+$/.test(d.id)) throw new RunConfigError(`${at} needs an "id" (letters, digits, _ . -)`);
		if (defs.has(d.id)) throw new RunConfigError(`${at}: the id "${d.id}" is used twice`);
		if (!PICK_TYPES.has(d.type as string)) throw new RunConfigError(`${at} ("${d.id}"): "type" must be "pick"`);
		if (d.description !== undefined && typeof d.description !== 'string') throw new RunConfigError(`${at}.description must be a string`);
		const hasCommand = typeof d.command === 'string' && d.command.trim() !== '';
		if (hasCommand === (d.options !== undefined)) throw new RunConfigError(`${at} ("${d.id}") needs "options" or a "command", one of them`);
		if (d.args !== undefined && !hasCommand) throw new RunConfigError(`${at} ("${d.id}"): "args" go with a "command"`);
		defs.set(d.id, {
			id: d.id,
			description: (d.description as string | undefined) || d.id,
			...(hasCommand ? { command: d.command as string } : { options: parseOptions(d.options, `${at}.options`) }),
			...(d.args !== undefined ? { args: strings(d.args, `${at}.args`) } : {}),
		});
	});
	return defs;
}

/** The ids of the inputs some strings name, in the order they first come. */
export function inputRefs(strings: readonly (string | undefined)[]): string[] {
	const out: string[] = [];
	for (const s of strings) {
		for (const m of (s ?? '').matchAll(INPUT_REF)) if (!out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

/**
 * JSON with comments and trailing commas (VSCode's files, run.json). Strings
 * are kept as they are: a "//" in a string is not a comment.
 */
export function parseJsonc(text: string, where: string): unknown {
	const out: string[] = [];
	// The last comma outside strings, while only spaces and comments follow it.
	let comma = -1;
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
			out.push(text.slice(i, j + 1));
			comma = -1;
			i = j + 1;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') i++;
		} else if (c === '/' && text[i + 1] === '*') {
			const end = text.indexOf('*/', i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			// A trailing comma, outside strings: gone before the } or ].
			if ((c === '}' || c === ']') && comma >= 0) out[comma] = '';
			if (c === ',') comma = out.length;
			else if (!/\s/.test(c)) comma = -1;
			out.push(c);
			i++;
		}
	}
	try {
		return JSON.parse(out.join(''));
	} catch (error) {
		throw new RunConfigError(`${where}: not valid JSON: ${(error as Error).message}`);
	}
}

function strings(value: unknown, what: string): string[] {
	if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new RunConfigError(`${what} must be a list of strings`);
	return value as string[];
}

function stringMap(value: unknown, what: string): Record<string, string> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new RunConfigError(`${what} must be an object of strings`);
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value)) {
		if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new RunConfigError(`${what}.${k} must be a string`);
		out[k] = String(v);
	}
	return out;
}

/** .symbiosis/run.json's text → its configurations. `where`: the file, for errors. */
export function parseRunJson(text: string, where = '.symbiosis/run.json'): RunConfig[] {
	const data = parseJsonc(text, where) as { configurations?: unknown; inputs?: unknown };
	if (typeof data !== 'object' || data === null || !Array.isArray(data.configurations)) {
		throw new RunConfigError(`${where}: needs "configurations": [ ... ]`);
	}
	const defs = parseInputs(data.inputs, where);
	const seen = new Set<string>();
	return data.configurations.map((raw: unknown, i: number) => {
		const c = raw as Record<string, unknown>;
		const at = `${where}: configurations[${i}]`;
		if (typeof c !== 'object' || c === null) throw new RunConfigError(`${at} must be an object`);
		if (typeof c.name !== 'string' || c.name.trim() === '') throw new RunConfigError(`${at} needs a "name"`);
		if (typeof c.command !== 'string' || c.command.trim() === '') throw new RunConfigError(`${at} ("${c.name}") needs a "command"`);
		if (seen.has(c.name)) throw new RunConfigError(`${at}: the name "${c.name}" is used twice`);
		seen.add(c.name);
		for (const key of ['cwd', 'envFile'] as const) {
			if (c[key] !== undefined && typeof c[key] !== 'string') throw new RunConfigError(`${at}.${key} must be a string`);
		}
		const config: RunConfig = {
			id: `saved:${c.name}`,
			name: c.name,
			group: 'Saved',
			command: c.command,
			...(c.args !== undefined ? { args: strings(c.args, `${at}.args`) } : {}),
			...(c.cwd !== undefined ? { cwd: c.cwd as string } : {}),
			...(c.env !== undefined ? { env: stringMap(c.env, `${at}.env`) } : {}),
			...(c.envFile !== undefined ? { envFile: c.envFile as string } : {}),
			source: where,
		};
		const refs = inputRefs([config.command, ...(config.args ?? []), config.cwd, config.envFile, ...Object.values(config.env ?? {})]);
		if (refs.length === 0) return config;
		const unknown = refs.filter((id) => !defs.has(id));
		if (unknown.length > 0) throw new RunConfigError(`${at} ("${c.name}"): no input "${unknown[0]}" in "inputs"`);
		return { ...config, inputs: refs.map((id) => defs.get(id)!) };
	});
}

/** A config as run.json holds it: for "Save" (copy a detected config into the file). */
export function toRunJson(config: RunConfig): Record<string, unknown> {
	return {
		name: config.name,
		command: config.command,
		...(config.args ? { args: [...config.args] } : {}),
		...(config.cwd ? { cwd: config.cwd } : {}),
		...(config.env ? { env: { ...config.env } } : {}),
		...(config.envFile ? { envFile: config.envFile } : {}),
	};
}

/** Quotes a word for sh when it needs it. */
export function shQuote(word: string): string {
	return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command as one line, for the picker and the panel. */
export function commandLine(config: Pick<RunConfig, 'command' | 'args'>): string {
	if (!config.args) return config.command;
	return [config.command, ...config.args].map(shQuote).join(' ');
}

/** A dotenv file: KEY=value lines, # comments, optional `export`, quotes. */
export function parseDotenv(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const m = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/.exec(raw);
		if (!m) continue;
		let value = m[2].trim();
		const q = value[0];
		if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) {
			value = value.slice(1, -1);
			if (q === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
		} else {
			value = value.replace(/\s+#.*$/, '');
		}
		out[m[1]] = value;
	}
	return out;
}
