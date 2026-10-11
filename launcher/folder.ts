// Which folder symbiosis opens: the argument, else the git root, else the
// current folder (decision 7).
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { UsageError } from './args.ts';

/** The top of the git work tree that holds `dir`, if any. */
export function gitRoot(dir: string): string | undefined {
	try {
		const out = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
		return out.trim() || undefined;
	} catch {
		return undefined;
	}
}

export function projectFolder(arg: string | undefined, cwd: string, root: (dir: string) => string | undefined = gitRoot): string {
	if (arg === undefined) return root(cwd) ?? cwd;
	const folder = resolve(cwd, arg);
	let isDir = false;
	try {
		isDir = statSync(folder).isDirectory();
	} catch {
		throw new UsageError(`symbiosis: no folder ${folder}`);
	}
	if (!isDir) throw new UsageError(`symbiosis: ${folder} is not a folder; give the folder that holds it`);
	return folder;
}
