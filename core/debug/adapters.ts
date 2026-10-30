// The debug adapters: for a spec's `type`, the program that speaks DAP, how
// to reach it (its stdin and stdout, or a TCP port it prints), and the
// arguments of its launch request.
//
//   python, debugpy          python -m debugpy.adapter (the program's python, else python3;
//                            debugpy from pip, else the copy in VS Code's Python Debugger extension)
//   lldb, lldb-dap, codelldb,
//   cppdbg                   lldb-dap (PATH, SYMBIOSIS_LLDB_DAP, or Xcode's: xcrun -f lldb-dap)
//   go                       dlv dap (PATH, or ~/go/bin)
//   node, pwa-node           js-debug's DAP server (SYMBIOSIS_JS_DEBUG: its dapDebugServer.js)
//
// A spec may name its own adapter: "adapter": ["my-dap", "--stdio"], or
// { "command": "my-dap", "args": [...], "port": true } for one that prints
// the port it listens on.
//
// What is not installed is a DebugSetupError that says how to install it.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { RunConfigError } from '../run/config.ts';
import { DEBUG_TYPES, type DebugSpec } from './spec.ts';

/** A debugger that is not there, or a spec it cannot take: `symbiosis run start --debug` says why. */
export class DebugSetupError extends RunConfigError {}

/** How to reach the adapter: its stdio, or the port it prints (the first number the pattern catches). */
export type Transport = { readonly kind: 'stdio' } | { readonly kind: 'tcp'; readonly pattern: string; readonly host: string };

export interface AdapterStart {
	readonly command: string;
	readonly args: readonly string[];
	/** Added to the supervisor's environment. */
	readonly env: Readonly<Record<string, string>>;
	readonly cwd: string;
	readonly transport: Transport;
	/** initialize's adapterID. */
	readonly adapterID: string;
	/** The launch request's arguments. */
	readonly launch: Readonly<Record<string, unknown>>;
	/** For the run's first lines: "debugpy 1.8 (python3)". */
	readonly label: string;
}

/** What the machine has: injected, so the tests need no debugger installed. */
export interface Probe {
	/** A program on PATH (or a path that exists), absolute; else undefined. */
	which(command: string): string | undefined;
	/** Whether `command args` exits 0 (with `env` added), within a few seconds. */
	ok(command: string, args: readonly string[], env?: Record<string, string>): boolean;
	/** The stdout of `command args` when it exits 0. */
	out(command: string, args: readonly string[]): string | undefined;
	exists(path: string): boolean;
	/** The names in a folder; [] when it is not there. */
	list(dir: string): string[];
	readonly home: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly platform: NodeJS.Platform;
}

export function systemProbe(env: NodeJS.ProcessEnv = process.env): Probe {
	return {
		which(command) {
			if (command.includes('/')) return existsSync(command) ? command : undefined;
			for (const dir of (env.PATH ?? '').split(delimiter)) {
				if (dir && existsSync(join(dir, command))) return join(dir, command);
			}
			return undefined;
		},
		ok(command, args, extra) {
			const r = spawnSync(command, [...args], { env: { ...env, ...extra }, stdio: 'ignore', timeout: 8000 });
			return r.status === 0;
		},
		out(command, args) {
			const r = spawnSync(command, [...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
			return r.status === 0 ? r.stdout.trim() : undefined;
		},
		exists: existsSync,
		list(dir) {
			try {
				return readdirSync(dir);
			} catch {
				return [];
			}
		},
		home: homedir(),
		env,
		platform: process.platform,
	};
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** The folders of an editor extension, newest version last: VS Code, Insiders, Cursor, VSCodium. */
function extensionDirs(probe: Probe, prefix: string): string[] {
	const out: string[] = [];
	for (const root of ['.vscode', '.vscode-insiders', '.cursor', '.vscode-oss', '.windsurf']) {
		const dir = join(probe.home, root, 'extensions');
		for (const name of probe.list(dir)) if (name.startsWith(prefix)) out.push(join(dir, name));
	}
	return out.sort((a, b) => versionOf(a) - versionOf(b));
}

function versionOf(dir: string): number {
	const m = /-(\d+)\.(\d+)\.(\d+)/.exec(dir);
	return m ? Number(m[1]) * 1e8 + Number(m[2]) * 1e4 + Number(m[3]) : 0;
}

/** The environment as lldb-dap and cppdbg want it, from an object. */
function envPairs(env: Record<string, string>): string[] {
	return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

function envObject(raw: unknown): Record<string, string> {
	if (Array.isArray(raw)) {
		// cppdbg: [{ name, value }]
		const out: Record<string, string> = {};
		for (const e of raw) if (e && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string') out[(e as { name: string }).name] = String((e as { value?: unknown }).value ?? '');
		return out;
	}
	if (typeof raw === 'object' && raw !== null) return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, String(v)]));
	return {};
}

function python(spec: DebugSpec, probe: Probe): AdapterStart {
	const wanted = str(spec.python) ?? (Array.isArray(spec.python) ? str(spec.python[0]) : undefined) ?? 'python3';
	const interpreter = probe.which(wanted);
	if (!interpreter) throw new DebugSetupError(`python: ${wanted} is not there`);
	const cwd = str(spec.cwd) ?? process.cwd();
	const launch = {
		...spec,
		type: 'python',
		python: interpreter,
		// The Run panel is the console: the program's output comes as DAP output events.
		console: 'internalConsole',
		redirectOutput: true,
		justMyCode: spec.justMyCode ?? true,
	};
	const has = (py: string, env?: Record<string, string>) => probe.ok(py, ['-c', 'import debugpy'], env);
	if (has(interpreter)) {
		return { command: interpreter, args: ['-m', 'debugpy.adapter'], env: {}, cwd, transport: { kind: 'stdio' }, adapterID: 'debugpy', launch, label: `debugpy (${wanted})` };
	}
	// debugpy is not in the program's python: the copy VS Code's Python Debugger
	// extension brings (bundled/libs), run by the same python.
	for (const dir of extensionDirs(probe, 'ms-python.debugpy-').reverse()) {
		const libs = join(dir, 'bundled', 'libs');
		if (!probe.exists(join(libs, 'debugpy'))) continue;
		const env = { PYTHONPATH: [libs, probe.env.PYTHONPATH].filter(Boolean).join(delimiter) };
		if (!has(interpreter, env)) continue;
		return { command: interpreter, args: ['-m', 'debugpy.adapter'], env, cwd, transport: { kind: 'stdio' }, adapterID: 'debugpy', launch, label: `debugpy from ${dir.replace(probe.home, '~')} (${wanted})` };
	}
	throw new DebugSetupError(`python: debugpy is not installed for ${wanted}; install it: ${wanted} -m pip install debugpy`);
}

function lldb(spec: DebugSpec, probe: Probe): AdapterStart {
	let adapter = str(probe.env.SYMBIOSIS_LLDB_DAP) ?? probe.which('lldb-dap') ?? probe.which('lldb-vscode');
	if (!adapter && probe.platform === 'darwin') adapter = probe.out('xcrun', ['-f', 'lldb-dap']);
	if (!adapter) {
		throw new DebugSetupError(probe.platform === 'darwin'
			? 'lldb: lldb-dap is not there; it comes with Xcode (xcode-select --install) or LLVM (brew install llvm)'
			: 'lldb: lldb-dap is not there; install LLVM\'s lldb (apt install lldb, then lldb-dap or lldb-vscode is on PATH)');
	}
	const program = str(spec.program);
	if (!program) throw new DebugSetupError(`${spec.type}: needs a "program"`);
	const env = { ...envObject(spec.env), ...envObject(spec.environment) };
	const { environment: _e, MIMode: _m, miDebuggerPath: _p, externalConsole: _x, ...rest } = spec as Record<string, unknown>;
	const launch = { ...rest, type: 'lldb-dap', program, args: Array.isArray(spec.args) ? spec.args : [], env: envPairs(env) };
	return { command: adapter, args: [], env: {}, cwd: str(spec.cwd) ?? process.cwd(), transport: { kind: 'stdio' }, adapterID: 'lldb-dap', launch, label: 'lldb-dap' };
}

function go(spec: DebugSpec, probe: Probe): AdapterStart {
	const dlv = probe.which('dlv') ?? [join(probe.home, 'go', 'bin', 'dlv')].find((p) => probe.exists(p));
	if (!dlv) throw new DebugSetupError('go: dlv (Delve) is not there; install it: go install github.com/go-delve/delve/cmd/dlv@latest');
	const launch = { ...spec, mode: spec.mode ?? 'debug', env: envObject(spec.env) };
	return {
		command: dlv, args: ['dap', '--listen=127.0.0.1:0'], env: {}, cwd: str(spec.cwd) ?? process.cwd(),
		transport: { kind: 'tcp', pattern: 'listening at:?\\s*[\\w.:\\[\\]]*:(\\d+)', host: '127.0.0.1' }, adapterID: 'go', launch, label: 'dlv dap',
	};
}

function node(spec: DebugSpec, probe: Probe): AdapterStart {
	const given = str(probe.env.SYMBIOSIS_JS_DEBUG);
	const candidates = [
		...(given ? [given, join(given, 'src', 'dapDebugServer.js'), join(given, 'js-debug', 'src', 'dapDebugServer.js')] : []),
		join(probe.home, '.local', 'share', 'symbiosis', 'js-debug', 'src', 'dapDebugServer.js'),
	];
	const server = candidates.find((p) => p.endsWith('.js') && probe.exists(p));
	if (!server) {
		throw new DebugSetupError('node: js-debug\'s DAP server is not there; get js-debug-dap-*.tar.gz from github.com/microsoft/vscode-js-debug/releases, '
			+ 'unpack it in ~/.local/share/symbiosis/ (or set SYMBIOSIS_JS_DEBUG to its dapDebugServer.js)');
	}
	const launch = { ...spec, type: 'pwa-node', console: 'internalConsole', outputCapture: spec.outputCapture ?? 'std' };
	return {
		command: process.execPath, args: [server, '0', '127.0.0.1'], env: {}, cwd: str(spec.cwd) ?? process.cwd(),
		transport: { kind: 'tcp', pattern: 'listening at [\\w.:\\[\\]]*:(\\d+)', host: '127.0.0.1' }, adapterID: 'pwa-node', launch, label: 'js-debug',
	};
}

function custom(spec: DebugSpec, probe: Probe): AdapterStart {
	const raw = spec.adapter;
	const argv = Array.isArray(raw) ? raw : typeof raw === 'object' && raw !== null ? [(raw as { command?: unknown }).command, ...(((raw as { args?: unknown }).args as unknown[]) ?? [])] : [raw];
	if (argv.length === 0 || argv.some((a) => typeof a !== 'string' || a === '')) throw new DebugSetupError(`${spec.type}: "adapter" must be a command: ["program", "arg", ...] or { "command", "args" }`);
	const [command, ...args] = argv as string[];
	const found = isAbsolute(command) ? (probe.exists(command) ? command : undefined) : probe.which(command);
	if (!found) throw new DebugSetupError(`${spec.type}: the adapter ${command} is not there`);
	const port = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && (raw as { port?: unknown }).port === true;
	const { adapter: _a, ...launch } = spec as Record<string, unknown>;
	return {
		command: found, args, env: {}, cwd: str(spec.cwd) ?? process.cwd(),
		transport: port ? { kind: 'tcp', pattern: ':(\\d{2,5})\\b', host: '127.0.0.1' } : { kind: 'stdio' },
		adapterID: spec.type, launch, label: command,
	};
}

const BY_TYPE: Readonly<Record<string, (spec: DebugSpec, probe: Probe) => AdapterStart>> = {
	python, debugpy: python,
	lldb, 'lldb-dap': lldb, codelldb: lldb, cppdbg: lldb,
	go,
	node, 'pwa-node': node,
};

/** The types of BY_TYPE (spec.ts DEBUG_TYPES says them to the parts that start no adapter; a test checks they agree). */
export const ADAPTER_TYPES = Object.keys(BY_TYPE);

export function adapterFor(spec: DebugSpec, probe: Probe = systemProbe()): AdapterStart {
	if (spec.adapter !== undefined) return custom(spec, probe);
	const make = BY_TYPE[spec.type];
	if (!make) throw new DebugSetupError(`symbiosis has no debugger for type "${spec.type}" (it knows ${DEBUG_TYPES.join(', ')}); a config may name one: "adapter": ["program", ...]`);
	return make(spec, probe);
}
