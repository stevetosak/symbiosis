// What pi changed in the current turn, file by file, for the diff key in ttt
// (ctrl+k w). The extension keeps, per file, the text from before pi first
// touched it in the turn and the text after its last change. The plugin reads
// only these files: ttt.fs cannot read outside the workspace.
//
//   changes/index.json      {session, turn, files: [{path, key, t}]}, last changed last
//   changes/<key>.json      {path, before: string | null, after: string | null}
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Bigger files are not kept: a diff of them is not readable anyway. */
const MAX_BYTES = 1024 * 1024;

export interface Change {
	path: string;
	before: string | null;
	after: string | null;
	/** The agent's reasons for the choices in this turn's changes to the file. */
	whys?: string[];
}

interface Entry {
	path: string;
	key: string;
	t: number;
}

/** The file's text, or null when it does not exist or is too big. */
export function readText(path: string): string | null {
	try {
		if (statSync(path).size > MAX_BYTES) return null;
		return readFileSync(path, 'utf-8');
	} catch {
		return null;
	}
}

/** A stable file name for a path. */
export function keyOf(path: string): string {
	let h = 0x811c9dc5;
	for (const ch of Buffer.from(path)) {
		h ^= ch;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(16).padStart(8, '0');
}

function write(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

export class Changes {
	readonly dir: string;
	readonly now: () => number;
	session = '';
	turn = 0;
	files: Entry[] = [];
	/** Paths whose "before" is kept in this turn. */
	seen = new Set<string>();

	constructor(dir: string, now: () => number = Date.now) {
		this.dir = dir;
		this.now = now;
	}

	/** A new turn of this session: the last turn's changes are dropped. */
	start(session: string): void {
		this.session = session;
		this.turn = this.now();
		this.files = [];
		this.seen.clear();
		rmSync(this.dir, { recursive: true, force: true });
	}

	/** Just before pi writes `path`: keep its text, once per turn. */
	before(path: string): void {
		if (this.seen.has(path)) return;
		this.seen.add(path);
		const text = readText(path);
		mkdirSync(this.dir, { recursive: true });
		write(join(this.dir, `${keyOf(path)}.json`), JSON.stringify({ path, before: text, after: text } satisfies Change));
	}

	/** After pi wrote `path`: keep its new text, and `why` it gave, and list it as the last change. */
	after(path: string, why?: string): void {
		if (!this.seen.has(path)) return;
		const file = join(this.dir, `${keyOf(path)}.json`);
		if (!existsSync(file)) return;
		const change = JSON.parse(readFileSync(file, 'utf-8')) as Change;
		change.after = readText(path);
		if (why) change.whys = [...(change.whys ?? []), why];
		write(file, JSON.stringify(change));
		this.files = this.files.filter((f) => f.path !== path);
		this.files.push({ path, key: keyOf(path), t: this.now() / 1000 });
		write(join(this.dir, 'index.json'), JSON.stringify({ session: this.session, turn: this.turn, files: this.files }));
	}
}
