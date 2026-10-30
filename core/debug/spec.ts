// What a debug session launches: a VS Code launch configuration (`type`,
// `request`, then the adapter's own attributes), taken as it is from
// .vscode/launch.json or the "debug" object of a .symbiosis/run.json
// configuration, or made from a run configuration's command when symbiosis
// knows the program:
//
//   python3 app.py --port 1     { type: "python", program: "app.py", args: ["--port", "1"] }
//   python -m pytest -x         { type: "python", module: "pytest", args: ["-x"] }
//   node --inspect x.js a       { type: "node", program: "x.js", runtimeArgs: ["--inspect"], args: ["a"] }
//   go run ./cmd/api -v         { type: "go", mode: "debug", program: "./cmd/api", args: ["-v"] }
//   ./build/app a b             { type: "lldb", program: "./build/app", args: ["a", "b"] }   (a compiled program)
//
// A shell line counts only when it is plain words (no quotes, pipes, $, &&).
import { closeSync, openSync, readSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { type RunConfig, RunConfigError } from '../run/config.ts';
import { CURRENT_FILE_ID, fileCommand } from '../run/file.ts';
import type { Launch } from '../run/list.ts';
import { expand, type VariableContext } from '../run/variables.ts';

export interface DebugSpec {
	readonly type: string;
	readonly request: 'launch';
	readonly [attribute: string]: unknown;
}

/** The types symbiosis has a debug adapter for (core/debug/adapters.ts); a spec with its own "adapter" may have any. */
export const DEBUG_TYPES: readonly string[] = ['python', 'debugpy', 'lldb', 'lldb-dap', 'codelldb', 'cppdbg', 'go', 'node', 'pwa-node'];

/** Whether symbiosis can start a debugger for the spec. */
export function hasAdapter(spec: DebugSpec): boolean {
	return spec.adapter !== undefined || DEBUG_TYPES.includes(spec.type);
}

/** launch.json's keys that are VS Code's, not the adapter's. */
const VSCODE_ONLY = new Set(['name', 'preLaunchTask', 'postDebugTask', 'presentation', 'internalConsoleOptions', 'serverReadyAction', 'debugServer']);

/** A launch.json configuration (or run.json's "debug") as a spec: VS Code's own keys taken out. */
export function specOf(raw: Record<string, unknown>, at: string): DebugSpec {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RunConfigError(`${at} must be an object`);
	if (typeof raw.type !== 'string' || raw.type === '') throw new RunConfigError(`${at} needs a "type": the debugger (python, node, go, lldb, ...)`);
	if (raw.request !== undefined && raw.request !== 'launch') throw new RunConfigError(`${at}: "request" must be "launch"; symbiosis debugs the programs it starts`);
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(raw)) if (!VSCODE_ONLY.has(k)) out[k] = v;
	return { ...out, type: raw.type, request: 'launch' } as DebugSpec;
}

const SIMPLE_WORDS = /^[\w@%+=:,./-]+(\s+[\w@%+=:,./-]+)*$/;

/** The words of a shell line that is only plain words, else undefined. */
export function plainWords(line: string): string[] | undefined {
	const t = line.trim();
	return SIMPLE_WORDS.test(t) ? t.split(/\s+/) : undefined;
}

/** Python's options that take a value (`-W error`, `-X dev`). */
const PY_VALUE_FLAGS = new Set(['-W', '-X', '-Q']);

function python(command: string, args: readonly string[]): DebugSpec | undefined {
	const pythonArgs: string[] = [];
	let i = 0;
	while (i < args.length && args[i].startsWith('-')) {
		const a = args[i];
		if (a === '-m') {
			const module = args[i + 1];
			if (!module) return undefined;
			return spec('python', { python: command, module, args: args.slice(i + 2), ...(pythonArgs.length ? { pythonArgs } : {}) });
		}
		// -c code: nothing to point a breakpoint at.
		if (a === '-c' || a === '-') return undefined;
		pythonArgs.push(a);
		if (PY_VALUE_FLAGS.has(a) && args[i + 1] !== undefined) pythonArgs.push(args[++i]);
		i++;
	}
	const program = args[i];
	if (!program) return undefined;
	return spec('python', { python: command, program, args: args.slice(i + 1), ...(pythonArgs.length ? { pythonArgs } : {}) });
}

function spec(type: string, attrs: Record<string, unknown>): DebugSpec {
	return { type, request: 'launch', ...attrs };
}

/** A Mach-O or ELF file: a program lldb can debug. */
export function isCompiled(path: string): boolean {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		const b = Buffer.alloc(4);
		if (readSync(fd, b, 0, 4, 0) < 4) return false;
		const magic = b.readUInt32BE(0);
		return magic === 0x7f454c46 || [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
	} catch {
		return false;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/**
 * A spec from a program and its arguments, or undefined when symbiosis does
 * not know how to debug it. `compiled(path)`: whether a path names a
 * compiled program (core/debug/spec.ts isCompiled, against the right folder).
 */
export function inferDebug(command: string, args: readonly string[] | undefined, compiled: (path: string) => boolean = () => false): DebugSpec | undefined {
	let argv = args ? [command, ...args] : plainWords(command);
	if (!argv || argv.length === 0) return undefined;
	// `uv run python x.py`, `poetry run python x.py`: the runner's python.
	if ((argv[0] === 'uv' || argv[0] === 'poetry') && argv[1] === 'run') return undefined;
	if (argv[0] === 'env') {
		// `env A=1 python x.py`: the variables go to the program's env.
		const env: Record<string, string> = {};
		let i = 1;
		for (; i < argv.length && /^[A-Za-z_]\w*=/.test(argv[i]); i++) {
			const eq = argv[i].indexOf('=');
			env[argv[i].slice(0, eq)] = argv[i].slice(eq + 1);
		}
		const inner = i < argv.length ? inferDebug(argv[i], argv.slice(i + 1), compiled) : undefined;
		return inner && Object.keys(env).length ? { ...inner, env: { ...env, ...(inner.env as Record<string, string> | undefined) } } : inner;
	}
	const [cmd, ...rest] = argv;
	const name = basename(cmd);
	if (/^python(\d+(\.\d+)*)?$/.test(name)) return python(cmd, rest);
	if (name === 'node') {
		const at = rest.findIndex((a) => !a.startsWith('-'));
		if (at < 0) return undefined;
		const runtimeArgs = rest.slice(0, at);
		// `node -e code`, `node --test`: no program to debug.
		if (runtimeArgs.some((a) => a === '-e' || a === '--eval' || a === '-p' || a === '--print' || a === '--test')) return undefined;
		return spec('node', {
			program: rest[at], args: rest.slice(at + 1),
			...(cmd !== 'node' ? { runtimeExecutable: cmd } : {}),
			...(runtimeArgs.length ? { runtimeArgs } : {}),
		});
	}
	if (name === 'go' && rest[0] === 'run') {
		const flags = [];
		let i = 1;
		while (i < rest.length && rest[i].startsWith('-')) flags.push(rest[i++]);
		const program = rest[i];
		if (!program) return undefined;
		return spec('go', { mode: 'debug', program, args: rest.slice(i + 1), ...(flags.length ? { buildFlags: flags.join(' ') } : {}) });
	}
	if (cmd.includes('/') && compiled(cmd)) return spec('lldb', { program: cmd, args: rest });
	return undefined;
}

/**
 * A config's spec, or undefined when it cannot be debugged: its own "debug"
 * (launch.json, run.json), else the one its command gives. `cwd`: where a
 * relative program is (variables in it left as they are: then a compiled
 * program is not found and the config does not count).
 */
export function debugSpecOf(config: RunConfig, opts: { file?: string; folder: string }): DebugSpec | undefined {
	if (config.debug) return config.debug;
	if (config.id === CURRENT_FILE_ID) {
		const cmd = opts.file ? fileCommand(opts.file) : undefined;
		return cmd ? inferDebug(cmd.command, cmd.args) : undefined;
	}
	const cwd = config.cwd && !config.cwd.includes('${') ? resolve(opts.folder, config.cwd) : opts.folder;
	return inferDebug(config.command, config.args, (p) => !p.includes('${') && isCompiled(resolve(cwd, p)));
}

/** Every string in a value with its variables expanded. */
export function expandDeep(value: unknown, ctx: VariableContext): unknown {
	if (typeof value === 'string') return expand(value, ctx);
	if (Array.isArray(value)) return value.map((v) => expandDeep(v, ctx));
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandDeep(v, ctx)]));
	}
	return value;
}

/**
 * The spec ready for its adapter: variables expanded, `cwd` and `env` from
 * the launch (the spec's own win), `program` absolute when it is a path
 * relative to cwd.
 */
export function resolveDebug(raw: DebugSpec, launch: Launch, ctx: VariableContext): DebugSpec {
	const s = expandDeep(raw, ctx) as Record<string, unknown>;
	const cwd = typeof s.cwd === 'string' ? resolve(launch.cwd, s.cwd) : launch.cwd;
	const ownEnv = typeof s.env === 'object' && s.env !== null && !Array.isArray(s.env) ? (s.env as Record<string, unknown>) : {};
	const env: Record<string, string> = { ...launch.env };
	for (const [k, v] of Object.entries(ownEnv)) if (v !== null && v !== undefined) env[k] = String(v);
	const out: Record<string, unknown> = { ...s, cwd, env };
	// go's program is a package (".", "./cmd/api"): dlv takes it against cwd.
	if (typeof s.program === 'string' && s.type !== 'go' && !isAbsolute(s.program)) out.program = resolve(cwd, s.program);
	// The run's own python, `.venv/bin/python`, is where its command would find it: in cwd.
	if (typeof s.python === 'string' && s.python.includes('/') && !isAbsolute(s.python)) out.python = resolve(cwd, s.python);
	return out as DebugSpec;
}
