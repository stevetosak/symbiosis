// Inputs when a run starts: the options of each input its configuration
// names (run.json's "inputs", core/run/config.ts), which one it takes, and
// the ones picked last time.
//
// A command prints its options as JSON: [{ "value", "label"?, "detail"?, "ready"? }]
// or ["a", "b"]. "ready": the option is up already (a booted simulator).
// It runs in the workspace folder; what it prints on stderr is the error
// when it fails.
//
// Which value a run takes (decide): the one given, else the one picked last
// time while it is still an option, else the only option, else the only one
// ready; else the user picks. Asked to pick again, the user always picks.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type InputDef, type InputOption, parseOptions, type RunConfig, RunConfigError } from './config.ts';
import { writeAtomic } from './runs.ts';
import { expand, expandShell, type VariableContext } from './variables.ts';

export const OPTIONS_TIMEOUT_MS = 20_000;

/** The options of an input: its list, or what its command prints (run in the workspace folder). */
export async function listOptions(def: InputDef, ctx: VariableContext, timeoutMs = OPTIONS_TIMEOUT_MS): Promise<InputOption[]> {
	if (def.options) return [...def.options];
	const at = `input "${def.id}"`;
	// An input's command names no other input.
	const plain = { ...ctx, inputs: undefined };
	const hasArgs = def.args !== undefined;
	const program = hasArgs ? expand(def.command!, plain) : '/bin/sh';
	const argv = hasArgs ? def.args!.map((a) => expand(a, plain)) : ['-c', expandShell(def.command!, plain)];
	return new Promise((done, fail) => {
		execFile(program, argv, { cwd: ctx.folder, env: { ...ctx.env }, timeout: timeoutMs, maxBuffer: 1 << 20, encoding: 'utf8' }, (error, stdout, stderr) => {
			if (error) {
				const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
				const why = e.code === 'ENOENT' ? `${program}: command not found`
					: e.killed ? `no answer in ${Math.round(timeoutMs / 1000)} s`
					: stderr.trim().split('\n').slice(-3).join(' · ') || `exited ${e.code}`;
				return fail(new RunConfigError(`${at}: ${why}`));
			}
			let raw: unknown;
			try {
				raw = JSON.parse(stdout);
			} catch {
				return fail(new RunConfigError(`${at}: its command printed no JSON list: ${stdout.trim().slice(0, 120) || '(nothing)'}`));
			}
			try {
				done(parseOptions(raw, at));
			} catch (err) {
				fail(err);
			}
		});
	});
}

/**
 * The option a run takes without asking, or undefined: the user picks.
 * `again`: the user asked to pick again.
 */
export function decide(options: readonly InputOption[], remembered: string | undefined, again = false): InputOption | undefined {
	if (again) return undefined;
	const last = options.find((o) => o.value === remembered);
	if (last) return last;
	if (options.length === 1) return options[0];
	const ready = options.filter((o) => o.ready);
	return ready.length === 1 ? ready[0] : undefined;
}

export interface Picked {
	readonly value: string;
	readonly label: string;
}

/** The values picked last, per workspace folder and input id: a JSON file. */
export class InputMemory {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	private all(): Record<string, Record<string, Picked>> {
		try {
			const data = JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
			return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, Record<string, Picked>>) : {};
		} catch {
			return {};
		}
	}

	get(folder: string, id: string): Picked | undefined {
		const p = this.all()[folder]?.[id];
		return p && typeof p.value === 'string' ? { value: p.value, label: typeof p.label === 'string' ? p.label : p.value } : undefined;
	}

	set(folder: string, picks: Readonly<Record<string, Picked>>): void {
		if (Object.keys(picks).length === 0) return;
		const data = this.all();
		data[folder] = { ...data[folder], ...picks };
		writeAtomic(this.path, `${JSON.stringify(data, null, '\t')}\n`);
	}
}

/** What the user is to pick: one input of a configuration, and its options. */
export interface InputAsk {
	readonly config: string;
	readonly name: string;
	readonly input: { readonly id: string; readonly description: string };
	readonly options: readonly InputOption[];
	/** The value picked last time, when it is still an option. */
	readonly current?: string;
}

export type Inputs =
	| { readonly values: Record<string, string>; readonly picks: Record<string, Picked> }
	| { readonly ask: InputAsk };

/**
 * The values of a configuration's inputs, one input after the other: the
 * given one, else decide's; the first the user must pick stops it with an
 * InputAsk. `labels`: the labels of the given values (the picker knows them).
 * `again`: every input not given is the user's to pick.
 */
export async function pickInputs(
	config: RunConfig, ctx: VariableContext, memory: InputMemory,
	given: Readonly<Record<string, string>> = {}, labels: Readonly<Record<string, string>> = {}, again = false,
): Promise<Inputs> {
	const values: Record<string, string> = {};
	const picks: Record<string, Picked> = {};
	for (const def of config.inputs ?? []) {
		const last = memory.get(ctx.folder, def.id);
		const value = given[def.id];
		if (value !== undefined) {
			values[def.id] = value;
			picks[def.id] = { value, label: labels[def.id] ?? (last?.value === value ? last.label : value) };
			continue;
		}
		const options = await listOptions(def, ctx);
		if (options.length === 0) throw new RunConfigError(`"${config.name}": no ${def.description} to pick from`);
		const pick = decide(options, last?.value, again);
		if (!pick) {
			const current = options.some((o) => o.value === last?.value) ? last?.value : undefined;
			return {
				ask: {
					config: config.id, name: config.name, input: { id: def.id, description: def.description }, options,
					...(current ? { current } : {}),
				},
			};
		}
		values[def.id] = pick.value;
		picks[def.id] = { value: pick.value, label: pick.label };
	}
	return { values, picks };
}

/** The labels picked last for a configuration's inputs, ", " between them; for the picker. */
export function pickedLabels(config: RunConfig, folder: string, memory: InputMemory): string | undefined {
	const labels = (config.inputs ?? []).map((d) => memory.get(folder, d.id)?.label).filter((l): l is string => !!l);
	return labels.length > 0 ? labels.join(', ') : undefined;
}
