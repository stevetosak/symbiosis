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
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { type InputDef, type InputOption, parseOptions, type RunConfig, RunConfigError } from './config.ts';
import { killGroup, writeAtomic } from './runs.ts';
import { expand, expandShell, type VariableContext } from './variables.ts';

export const OPTIONS_TIMEOUT_MS = 20_000;
const OPTIONS_MAX_BYTES = 1 << 20;
/** After its command exits: how long what it started may still hold its output. */
const OPTIONS_CLOSE_MS = 200;

/** A time for an error: "800 ms", "1.5 s", "20 s". */
function took(ms: number): string {
	return ms < 1000 ? `${ms} ms` : `${Number((ms / 1000).toFixed(1))} s`;
}

/**
 * The options of an input: its list, or what its command prints. The command
 * runs in the workspace folder with no stdin, in a process group of its own:
 * on a timeout, too much output, or once it has exited, what it started is
 * killed with it.
 */
export async function listOptions(def: InputDef, ctx: VariableContext, timeoutMs = OPTIONS_TIMEOUT_MS): Promise<InputOption[]> {
	if (def.options) return [...def.options];
	const at = `input "${def.id}"`;
	const hasArgs = def.args !== undefined;
	const program = hasArgs ? expand(def.command!, ctx) : '/bin/sh';
	const argv = hasArgs ? def.args!.map((a) => expand(a, ctx)) : ['-c', expandShell(def.command!, ctx)];
	const stdout = await new Promise<string>((done, fail) => {
		const child = spawn(program, argv, { cwd: ctx.folder, env: { ...ctx.env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let bytes = 0;
		let settled = false;
		const settle = (error: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			killGroup(child.pid, 'SIGKILL');
			if (error) fail(new RunConfigError(`${at}: ${error}`));
			else done(Buffer.concat(out).toString('utf8'));
		};
		const timer = setTimeout(() => settle(`no answer in ${took(timeoutMs)}`), timeoutMs);
		child.stdout.on('data', (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > OPTIONS_MAX_BYTES) settle(`its command printed more than ${OPTIONS_MAX_BYTES >> 20} MB`);
			else out.push(chunk);
		});
		child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
		child.on('error', (error: NodeJS.ErrnoException) => settle(error.code === 'ENOENT' ? `${program}: command not found` : error.message));
		child.on('exit', (code, signal) => {
			const why = () => Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' · ')
				|| (signal ? `killed by ${signal}` : `exited ${code}`);
			// Its output is all there on close; a child it left may hold it open.
			const finish = () => settle(code === 0 ? undefined : why());
			child.once('close', finish);
			setTimeout(finish, OPTIONS_CLOSE_MS);
		});
	});
	let raw: unknown;
	try {
		raw = JSON.parse(stdout);
	} catch {
		throw new RunConfigError(`${at}: its command printed no JSON list: ${stdout.trim().slice(0, 120) || '(nothing)'}`);
	}
	return parseOptions(raw, at);
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
	/** The inputs before it, decided or given (id → value, id → label): what to give next time. */
	readonly given: Readonly<Record<string, string>>;
	readonly labels: Readonly<Record<string, string>>;
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
					given: values,
					labels: Object.fromEntries(Object.entries(picks).map(([id, p]) => [id, p.label])),
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
