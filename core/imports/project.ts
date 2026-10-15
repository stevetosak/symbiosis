// What an import policy may read of the project: its manifests and whether a
// module file exists. The policies take this interface, so they are tested
// with a project in memory; `fsProject` is the one on disk.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Project {
	/** A file's text, by its path from the project root; null when it is missing. */
	read(path: string): string | null;
	exists(path: string): boolean;
	/** The file names in a folder, by its path from the root; [] when it is missing. */
	list(path: string): string[];
	/** A program's standard output; null when it is missing or fails. */
	run(program: string, args: string[]): string | null;
}

/** The project on disk under `root`. */
export function fsProject(root: string): Project {
	return {
		read(path) {
			try {
				return readFileSync(join(root, path), 'utf8');
			} catch {
				return null;
			}
		},
		exists: (path) => existsSync(join(root, path)),
		list(path) {
			try {
				return readdirSync(join(root, path));
			} catch {
				return [];
			}
		},
		run(program, args) {
			try {
				return execFileSync(program, args, { cwd: root, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
			} catch {
				return null;
			}
		},
	};
}
