// One record per running symbiosis, keyed on its folder, so a second
// `symbiosis` for the same folder finds the first (decision 8):
//
//   ~/.local/state/symbiosis/<hash of the folder>.json
//
// A record whose process is gone is old: it is removed and not trusted.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Host {
	kind: 'herdr' | 'tmux';
	pane: string;
}

export interface OpenRecord {
	pid: number;
	folder: string;
	/** Unix milliseconds. */
	started: number;
	/** The pane it runs in, to go there later. */
	host: Host | null;
	/** The pane the launcher made for pi: `symbiosis close` closes it. Null: none (no herdr, no tmux). */
	pi?: string | null;
}

export function stateDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.XDG_STATE_HOME || join(home, '.local', 'state'), 'symbiosis');
}

export function recordPath(dir: string, folder: string): string {
	return join(dir, `${createHash('sha256').update(folder).digest('hex').slice(0, 16)}.json`);
}

/** The pane this process runs in, if a multiplexer says so. */
export function hostOf(env: NodeJS.ProcessEnv = process.env): Host | null {
	if (env.HERDR_PANE_ID) return { kind: 'herdr', pane: env.HERDR_PANE_ID };
	if (env.TMUX && env.TMUX_PANE) return { kind: 'tmux', pane: env.TMUX_PANE };
	return null;
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists, it belongs to someone else.
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/** The live record for `folder`, if any. An old one is removed. */
export function findOpen(dir: string, folder: string, isAlive: (pid: number) => boolean = alive): OpenRecord | undefined {
	const path = recordPath(dir, folder);
	let record: OpenRecord;
	try {
		record = JSON.parse(readFileSync(path, 'utf-8')) as OpenRecord;
	} catch {
		return undefined;
	}
	if (typeof record?.pid === 'number' && record.folder === folder && isAlive(record.pid)) return record;
	rmSync(path, { force: true });
	return undefined;
}

/** The live record of the symbiosis with process `pid`, if any. */
export function findByPid(dir: string, pid: number, isAlive: (pid: number) => boolean = alive): OpenRecord | undefined {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return undefined;
	}
	for (const name of names) {
		if (!name.endsWith('.json')) continue;
		try {
			const record = JSON.parse(readFileSync(join(dir, name), 'utf-8')) as OpenRecord;
			if (record?.pid === pid && typeof record.folder === 'string' && isAlive(pid)) return record;
		} catch {}
	}
	return undefined;
}

export function writeRecord(dir: string, record: OpenRecord): string {
	mkdirSync(dir, { recursive: true });
	const path = recordPath(dir, record.folder);
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, JSON.stringify(record));
	renameSync(temporary, path);
	return path;
}

/** Removes the record only if it is still this process's (a `--new` run may have replaced it). */
export function removeRecord(dir: string, folder: string, pid: number): void {
	const path = recordPath(dir, folder);
	try {
		const record = JSON.parse(readFileSync(path, 'utf-8')) as OpenRecord;
		if (record.pid !== pid) return;
	} catch {
		return;
	}
	rmSync(path, { force: true });
}

/** What to say when symbiosis already runs for the folder. */
export function alreadyOpen(record: OpenRecord): string {
	const where = record.host ? `in ${record.host.kind} pane ${record.host.pane}` : `as process ${record.pid}`;
	return `symbiosis already runs for ${record.folder} ${where}.\nGo there, or run symbiosis --new to open another one.`;
}
