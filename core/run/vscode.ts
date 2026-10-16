// Imports the configurations a repository already has for VSCode:
// .vscode/launch.json (launch requests whose program symbiosis can start
// without a debugger) and .vscode/tasks.json (shell, process and npm tasks).
// What cannot be run comes back as a problem, not silently dropped.
import { parseJsonc, type RunConfig, shQuote } from './config.ts';

type Json = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const list = (v: unknown): string[] =>
	Array.isArray(v) ? v.map((a) => (typeof a === 'string' ? a : str((a as Json)?.value) ?? '')).filter((a) => a !== '') : typeof v === 'string' ? [v] : [];

function envOf(v: unknown): Record<string, string> | undefined {
	if (typeof v !== 'object' || v === null) return undefined;
	const out: Record<string, string> = {};
	for (const [k, val] of Object.entries(v)) if (val !== null && val !== undefined) out[k] = String(val);
	return Object.keys(out).length ? out : undefined;
}

/** A launch configuration as a program and its arguments, or why it cannot run. */
export function launchCommand(c: Json): { command: string; args: string[] } | string {
	const type = str(c.type) ?? '';
	const program = str(c.program);
	const args = list(c.args);
	switch (type) {
		case 'node':
		case 'pwa-node': {
			const runtime = str(c.runtimeExecutable) ?? 'node';
			const runtimeArgs = list(c.runtimeArgs);
			if (!program && runtimeArgs.length === 0) return 'needs a "program" or "runtimeArgs"';
			return { command: runtime, args: [...runtimeArgs, ...(program ? [program] : []), ...args] };
		}
		case 'node-terminal': {
			const command = str(c.command);
			return command ? { command: 'sh', args: ['-c', command] } : 'needs a "command"';
		}
		case 'python':
		case 'debugpy': {
			const python = str(c.python) ?? 'python3';
			const module = str(c.module);
			if (module) return { command: python, args: ['-m', module, ...args] };
			return program ? { command: python, args: [program, ...args] } : 'needs a "program" or "module"';
		}
		case 'go':
			return program ? { command: 'go', args: ['run', program, ...args] } : 'needs a "program"';
		case 'coreclr':
			return program ? { command: 'dotnet', args: [program, ...args] } : 'needs a "program"';
		case 'cppdbg':
		case 'lldb':
		case 'codelldb':
			return program ? { command: program, args } : 'needs a "program"';
		default:
			return `type "${type}" is not one symbiosis can run`;
	}
}

export function importLaunch(text: string, source = '.vscode/launch.json'): { configs: RunConfig[]; problems: string[] } {
	const data = parseJsonc(text, source) as { configurations?: unknown };
	const configs: RunConfig[] = [];
	const problems: string[] = [];
	for (const raw of Array.isArray(data?.configurations) ? data.configurations : []) {
		const c = raw as Json;
		const name = str(c?.name);
		if (!name) continue;
		if (str(c.request) !== 'launch') {
			problems.push(`${source}: "${name}" attaches to a program; symbiosis starts programs`);
			continue;
		}
		const cmd = launchCommand(c);
		if (typeof cmd === 'string') {
			problems.push(`${source}: "${name}" ${cmd}`);
			continue;
		}
		configs.push({
			id: `vscode:${name}`,
			name,
			group: 'VS Code',
			...cmd,
			...(str(c.cwd) ? { cwd: str(c.cwd) } : {}),
			...(envOf(c.env) ? { env: envOf(c.env) } : {}),
			...(str(c.envFile) ? { envFile: str(c.envFile) } : {}),
			source,
		});
	}
	return { configs, problems };
}

export function importTasks(text: string, source = '.vscode/tasks.json'): { configs: RunConfig[]; problems: string[] } {
	const data = parseJsonc(text, source) as { tasks?: unknown };
	const configs: RunConfig[] = [];
	const problems: string[] = [];
	for (const raw of Array.isArray(data?.tasks) ? data.tasks : []) {
		const t = raw as Json;
		const type = str(t?.type) ?? 'process';
		const options = (t.options ?? {}) as Json;
		const base = {
			group: 'VS Code tasks',
			...(str(options.cwd) ? { cwd: str(options.cwd) } : {}),
			...(envOf(options.env) ? { env: envOf(options.env) } : {}),
			source,
		};
		if (type === 'npm') {
			const script = str(t.script);
			if (!script) continue;
			const name = str(t.label) ?? `npm: ${script}`;
			configs.push({ id: `vscode-task:${name}`, name, ...base, command: 'npm', args: ['run', script], ...(str(t.path) ? { cwd: str(t.path) } : {}) });
			continue;
		}
		const name = str(t.label) ?? str(t.taskName);
		const command = str(t.command);
		if (!name) continue;
		if (!command) {
			problems.push(`${source}: task "${name}" has no command`);
			continue;
		}
		if (type === 'shell') {
			const args = list(t.args);
			configs.push({ id: `vscode-task:${name}`, name, ...base, command: [command, ...args.map(shQuote)].join(' ') });
		} else if (type === 'process') {
			configs.push({ id: `vscode-task:${name}`, name, ...base, command, args: list(t.args) });
		} else {
			problems.push(`${source}: task "${name}" has type "${type}"; symbiosis runs shell, process and npm tasks`);
		}
	}
	return { configs, problems };
}
