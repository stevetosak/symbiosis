// "Current file": runs the file open in the editor with its language's
// program. The config is the same for every file; the command is made when
// the run starts, from the file then open.
import { existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { RunConfig } from './config.ts';

export const CURRENT_FILE_ID = 'file';

/** The program for a file, by its extension; [command, ...args before the file]. */
const RUNNERS: Readonly<Record<string, readonly string[]>> = {
	'.js': ['node'],
	'.mjs': ['node'],
	'.cjs': ['node'],
	'.ts': ['node'],
	'.mts': ['node'],
	'.cts': ['node'],
	'.py': ['python3'],
	'.go': ['go', 'run'],
	'.sh': ['bash'],
	'.bash': ['bash'],
	'.zsh': ['zsh'],
	'.rb': ['ruby'],
	'.lua': ['lua'],
	'.php': ['php'],
	'.pl': ['perl'],
	'.swift': ['swift'],
	'.java': ['java'],
	'.cs': ['dotnet', 'run'],
	'.kts': ['kotlin'],
	'.dart': ['dart', 'run'],
	'.exs': ['elixir'],
	'.r': ['Rscript'],
	'.jl': ['julia'],
	'.ps1': ['pwsh', '-File'],
};

/** The command for a file, or undefined when symbiosis does not know how to run it. */
export function fileCommand(file: string): { command: string; args: string[] } | undefined {
	const runner = RUNNERS[extname(file).toLowerCase()];
	if (!runner) return undefined;
	let [command, ...pre] = runner;
	// Python: the project's .venv next to the file or above it.
	if (command === 'python3') {
		for (let d = dirname(file); ; d = dirname(d)) {
			const venv = join(d, '.venv', 'bin', 'python');
			if (existsSync(venv)) {
				command = venv;
				break;
			}
			if (dirname(d) === d) break;
		}
	}
	return { command, args: [...pre, file] };
}

export function currentFileConfig(file: string | undefined): RunConfig {
	const cmd = file ? fileCommand(file) : undefined;
	return {
		id: CURRENT_FILE_ID,
		name: 'Current file',
		group: 'Current file',
		command: cmd?.command ?? '',
		args: cmd?.args ?? [],
		cwd: '${fileDirname}',
	};
}
