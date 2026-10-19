// What a write or edit call names: its path and its first changed line. Pure,
// so the tests need no pi and no ttt.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { Tool } from './protocol.ts';

/** The absolute path a tool call names: `~/` is the home folder, a relative path is from cwd. */
export function absolutePath(path: string, cwd: string, home = homedir()): string {
	if (path === '~' || path.startsWith('~/')) return join(home, path.slice(1));
	return isAbsolute(path) ? path : resolve(cwd, path);
}

/** The first changed line of a tool result: pi's edit reports it, a write starts at line 1. */
export function firstLine(tool: Tool, details: unknown): number {
	const first = (details as { firstChangedLine?: unknown } | undefined)?.firstChangedLine;
	return tool === 'edit' && typeof first === 'number' && first > 0 ? first : 1;
}
