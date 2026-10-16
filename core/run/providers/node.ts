// JavaScript and TypeScript: package.json scripts, run with the package
// manager the lockfile (or "packageManager") names; deno.json tasks.
import { parseJsonc } from '../config.ts';
import type { RunConfig } from '../config.ts';
import { cwdOf, type Folder, named, type Provider, sourceOf } from './provider.ts';

const LOCKS: readonly [string, string][] = [
	['pnpm-lock.yaml', 'pnpm'],
	['yarn.lock', 'yarn'],
	['bun.lock', 'bun'],
	['bun.lockb', 'bun'],
	['package-lock.json', 'npm'],
];

/** The package manager for a folder: "packageManager", else the nearest lockfile, else npm. */
export function packageManager(folder: Folder, pkg: { packageManager?: unknown }): string {
	if (typeof pkg.packageManager === 'string') {
		const name = pkg.packageManager.split('@')[0];
		if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) return name;
	}
	let best: { depth: number; pm: string } | undefined;
	for (const [lock, pm] of LOCKS) {
		const at = folder.up(lock);
		if (at === undefined) continue;
		const depth = at === '' ? 0 : at.split('/').length;
		if (!best || depth > best.depth) best = { depth, pm };
	}
	return best?.pm ?? 'npm';
}

// Scripts that only run as part of another (npm runs pre/post itself).
const HOOK = /^(pre|post)(install|uninstall|publish|pack|version|prepare|test|start|build|dev)$|^prepare$|^prepublishOnly$/;

export const node: Provider = {
	name: 'npm',
	detect(folder: Folder): RunConfig[] {
		const out: RunConfig[] = [];
		const text = folder.read('package.json');
		if (text !== undefined) {
			let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown } = {};
			try {
				pkg = parseJsonc(text, sourceOf(folder, 'package.json')) as typeof pkg;
			} catch {
				// A broken package.json: no scripts.
			}
			const pm = packageManager(folder, pkg);
			for (const [script, body] of Object.entries(pkg.scripts ?? {})) {
				if (typeof body !== 'string' || HOOK.test(script)) continue;
				out.push({
					...named(pm, folder, script),
					group: pm,
					command: pm,
					args: pm === 'npm' || pm === 'bun' ? ['run', script] : [script],
					...cwdOf(folder),
					source: sourceOf(folder, 'package.json'),
				});
			}
		}
		for (const file of ['deno.json', 'deno.jsonc']) {
			const deno = folder.read(file);
			if (deno === undefined) continue;
			let tasks: Record<string, unknown> = {};
			try {
				tasks = (parseJsonc(deno, file) as { tasks?: Record<string, unknown> }).tasks ?? {};
			} catch {
				// none
			}
			for (const task of Object.keys(tasks)) {
				out.push({ ...named('deno', folder, task), group: 'deno', command: 'deno', args: ['task', task], ...cwdOf(folder), source: sourceOf(folder, file) });
			}
		}
		return out;
	},
};
