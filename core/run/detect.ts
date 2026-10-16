// Detection: walks the workspace (a few levels down, for monorepos) and asks
// every provider about every folder. Folders that hold dependencies, builds
// or caches are skipped.
import { existsSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { RunConfig } from './config.ts';
import { dotnet, cargo, go } from './providers/native.ts';
import { jvm } from './providers/jvm.ts';
import { node } from './providers/node.ts';
import type { Folder, Provider } from './providers/provider.ts';
import { readHead, readSmall } from './providers/provider.ts';
import { pythonProvider } from './providers/python.ts';
import { tasks } from './providers/tasks.ts';

export const PROVIDERS: readonly Provider[] = [node, cargo, go, dotnet, pythonProvider, jvm, tasks];

const SKIP = new Set([
	'node_modules', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'vendor', 'venv', '__pycache__',
	'coverage', 'tmp', 'temp', 'logs', 'Pods', 'DerivedData',
]);

export interface WalkOptions {
	readonly depth?: number;
	readonly maxFolders?: number;
}

/** The folders of the workspace, the root first, breadth first. */
export function walk(root: string, opts: WalkOptions = {}): Folder[] {
	const depth = opts.depth ?? 4;
	const max = opts.maxFolders ?? 2000;
	const out: Folder[] = [];
	const queue: { rel: string; level: number }[] = [{ rel: '', level: 0 }];
	while (queue.length > 0 && out.length < max) {
		const { rel, level } = queue.shift()!;
		const dir = rel ? join(root, rel) : root;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		const files = new Set<string>();
		for (const e of entries) {
			if (e.isFile() || e.isSymbolicLink()) files.add(e.name);
			else if (e.isDirectory() && level < depth && !e.name.startsWith('.') && !SKIP.has(e.name)) {
				queue.push({ rel: rel ? posix.join(rel, e.name) : e.name, level: level + 1 });
			}
		}
		out.push(folderAt(root, rel, files));
	}
	return out;
}

export function folderAt(root: string, rel: string, files: ReadonlySet<string>): Folder {
	const dir = rel ? join(root, rel) : root;
	return {
		root,
		dir,
		rel,
		files,
		read: (name) => readSmall(join(dir, name)),
		head: (name, bytes) => readHead(join(dir, name), bytes),
		up(name) {
			let at = rel;
			for (;;) {
				if (existsSync(join(root, at, name))) return at;
				if (at === '') return undefined;
				at = posix.dirname(at) === '.' ? '' : posix.dirname(at);
			}
		},
	};
}

/** Every provider's configs for every folder; a provider that throws is skipped for that folder. */
export function detect(root: string, opts: WalkOptions = {}, providers: readonly Provider[] = PROVIDERS): { configs: RunConfig[]; problems: string[] } {
	const configs: RunConfig[] = [];
	const problems: string[] = [];
	const ids = new Set<string>();
	for (const folder of walk(root, opts)) {
		for (const p of providers) {
			try {
				for (const c of p.detect(folder)) {
					if (ids.has(c.id)) continue;
					ids.add(c.id);
					configs.push(c);
				}
			} catch (error) {
				problems.push(`${p.name} in ${folder.rel || '.'}: ${(error as Error).message}`);
			}
		}
	}
	return { configs, problems };
}
