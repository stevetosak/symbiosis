// Task runners and process files: Makefile targets, justfile recipes,
// Taskfile tasks, Procfile processes, docker compose services.
import type { RunConfig } from '../config.ts';
import { cwdOf, type Folder, named, type Provider, sourceOf } from './provider.ts';

/**
 * A Makefile's targets: not special (.PHONY), not a pattern (%), not a
 * variable (:=), not in a define...endef; a name with a dot or a slash only
 * when .PHONY says it is no file (test.unit).
 */
export function makeTargets(text: string): string[] {
	const found: string[] = [];
	const phony = new Set<string>();
	let define = false;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*define\b/.test(line)) define = true;
		if (define) {
			if (/^\s*endef\b/.test(line)) define = false;
			continue;
		}
		const p = /^\.PHONY\s*:(.*)$/.exec(line);
		if (p) for (const t of p[1].trim().split(/\s+/)) if (t) phony.add(t);
		const m = /^([A-Za-z0-9_][A-Za-z0-9_.\/-]*(?:\s+[A-Za-z0-9_][A-Za-z0-9_.\/-]*)*)\s*:(?![:=])/.exec(line);
		if (!m) continue;
		for (const t of m[1].split(/\s+/)) if (!t.includes('%') && !found.includes(t)) found.push(t);
	}
	return found.filter((t) => phony.has(t) || (!t.includes('/') && !t.includes('.')));
}

/** A justfile's recipes: `name args...:` at the start of a line, not `_private`. */
export function justRecipes(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^@?([A-Za-z][\w-]*)(?:\s+[^:]*)?:(?!=)/.exec(line);
		if (m && !['set', 'alias', 'export', 'import', 'mod'].includes(m[1]) && !out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

/**
 * The keys one level under a top-level YAML key (`tasks:`, `services:`):
 * enough YAML for Taskfile.yml and compose.yaml, which keep them at one indent.
 */
export function yamlKeys(text: string, top: string): string[] {
	const out: string[] = [];
	let inside = false;
	let indent = -1;
	for (const line of text.split(/\r?\n/)) {
		if (/^\s*(#|$)/.test(line)) continue;
		if (/^\S/.test(line)) {
			inside = line.startsWith(`${top}:`);
			indent = -1;
			continue;
		}
		if (!inside) continue;
		const m = /^(\s+)(["']?)([\w.-]+)\2\s*:/.exec(line);
		if (!m) continue;
		if (indent < 0) indent = m[1].length;
		if (m[1].length === indent && !out.includes(m[3])) out.push(m[3]);
	}
	return out;
}

/** A Procfile's processes: `name: command`. */
export function procfile(text: string): [string, string][] {
	const out: [string, string][] = [];
	for (const line of text.split(/\r?\n/)) {
		const m = /^([\w-]+)\s*:\s*(.+)$/.exec(line);
		if (m) out.push([m[1], m[2].trim()]);
	}
	return out;
}

const COMPOSE = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const TASKFILE = ['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'];
const JUSTFILE = ['justfile', 'Justfile', '.justfile'];
const MAKEFILE = ['Makefile', 'makefile', 'GNUmakefile'];

function first(folder: Folder, names: readonly string[]): string | undefined {
	return names.find((n) => folder.files.has(n));
}

export const tasks: Provider = {
	name: 'tasks',
	detect(folder: Folder): RunConfig[] {
		const out: RunConfig[] = [];
		const add = (provider: string, group: string, file: string, thing: string, rest: Omit<RunConfig, 'id' | 'name' | 'group'>) =>
			out.push({ ...named(provider, folder, thing), group, ...cwdOf(folder), source: sourceOf(folder, file), ...rest });

		const make = first(folder, MAKEFILE);
		if (make) for (const t of makeTargets(folder.read(make) ?? '')) add('make', 'make', make, t, { command: 'make', args: [t] });
		const just = first(folder, JUSTFILE);
		if (just) for (const r of justRecipes(folder.read(just) ?? '')) add('just', 'just', just, r, { command: 'just', args: [r] });
		const task = first(folder, TASKFILE);
		if (task) for (const t of yamlKeys(folder.read(task) ?? '', 'tasks')) add('task', 'Task', task, t, { command: 'task', args: [t] });
		if (folder.files.has('Procfile')) {
			for (const [name, line] of procfile(folder.read('Procfile') ?? '')) add('procfile', 'Procfile', 'Procfile', name, { command: line });
		}
		const compose = first(folder, COMPOSE);
		if (compose) {
			const file = compose;
			add('compose', 'Docker Compose', file, 'up', { command: 'docker', args: ['compose', '-f', file, 'up'] });
			for (const s of yamlKeys(folder.read(file) ?? '', 'services')) {
				add('compose', 'Docker Compose', file, `up ${s}`, { command: 'docker', args: ['compose', '-f', file, 'up', s] });
			}
		}
		return out;
	},
};
