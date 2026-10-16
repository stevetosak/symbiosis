// A provider detects run configurations from a project's files, with no
// configuration written: npm scripts, Cargo binaries, Makefile targets, ...
// One provider per ecosystem (core/run/providers/*.ts); detect.ts walks the
// workspace and gives each provider every folder it finds.
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { RunConfig } from '../config.ts';

export interface Folder {
	/** The workspace folder, absolute. */
	readonly root: string;
	/** This folder, absolute. */
	readonly dir: string;
	/** This folder relative to the root; "" for the root. */
	readonly rel: string;
	/** The names of its files (not folders). */
	readonly files: ReadonlySet<string>;
	/** A file's text, or undefined; at most 1 MB. */
	read(name: string): string | undefined;
	/** The first `bytes` of a file, or undefined. */
	head(name: string, bytes: number): string | undefined;
	/** The nearest folder at or above this one (up to the root) that has the file; its rel. */
	up(name: string): string | undefined;
}

export interface Provider {
	readonly name: string;
	detect(folder: Folder): RunConfig[];
}

const MAX_READ = 1 << 20;

export function readHead(path: string, bytes: number): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, 'r');
		const buf = Buffer.alloc(bytes);
		return buf.subarray(0, readSync(fd, buf, 0, bytes, 0)).toString('utf8');
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function readSmall(path: string): string | undefined {
	try {
		const text = readFileSync(path, 'utf8');
		return text.length > MAX_READ ? undefined : text;
	} catch {
		return undefined;
	}
}

/** A config's id and name for a thing in a folder: "npm:web:dev", "web: dev". */
export function named(provider: string, folder: Folder, thing: string): { id: string; name: string } {
	return { id: `${provider}:${folder.rel}:${thing}`, name: folder.rel ? `${folder.rel}: ${thing}` : thing };
}

/** cwd for a config that runs in `folder`: relative to the workspace folder, undefined at the root. */
export function cwdOf(folder: Folder): { cwd?: string } {
	return folder.rel ? { cwd: folder.rel } : {};
}

/** The source of a config: the file, relative to the workspace folder. */
export function sourceOf(folder: Folder, file: string): string {
	return folder.rel ? join(folder.rel, file) : file;
}
