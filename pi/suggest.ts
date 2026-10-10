// Suggestions: comments in the code that end in `AI!` (change this) or `AI?`
// (answer this). Pure parts, so the tests need no pi and no ttt. The ttt
// plugin uses the same rule (ttt/symbiosis/plugin.lua) for the gutter.
//
// Where the comment sits sets its reach:
//   * after code on the same line          -> that line
//   * on its own line                      -> the block below it (function, class, ...)
//   * on its own line at the top of a file -> the file, when a blank line follows it
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type Scope = 'line' | 'block' | 'file';

export interface Marker {
	path: string;
	line: number;
	kind: '!' | '?';
	note: string;
	scope: Scope;
	/** The code the marker points at: its own line for `line`, the next code line otherwise. */
	target: string;
}

/** Comment openers, by priority: `;` and `#` come last, as code uses them too. */
const OPENERS = ['<!--', '/*', '//', '--', '#', ';'];
const END = /\s*AI([!?])\s*(?:\*\/|-->)?\s*$/;
const COMMENT_LINE = /^\s*(\/\/|#|--|;|\/\*|\*|<!--)/;

/** A comment that ends in AI! or AI?: where its opener starts, the note, the kind. */
function match(line: string): { index: number; note: string; kind: '!' | '?' } | undefined {
	const end = END.exec(line);
	if (!end) return undefined;
	const body = line.slice(0, end.index);
	for (const o of OPENERS) {
		const index = body.indexOf(o);
		if (index >= 0) return { index, note: body.slice(index + o.length).trim(), kind: end[1] as '!' | '?' };
	}
	return undefined;
}

export function parseMarkers(path: string, text: string): Marker[] {
	const lines = text.split('\n');
	const out: Marker[] = [];
	let topComments = true;
	lines.forEach((line, i) => {
		const blank = line.trim() === '';
		const ownLine = COMMENT_LINE.test(line);
		const m = match(line);
		if (m) {
			const before = line.slice(0, m.index).trim();
			let scope: Scope = 'line';
			let target = line.slice(0, m.index).trim();
			if (before === '') {
				const nextIndex = lines.findIndex((l, j) => j > i && l.trim() !== '' && !COMMENT_LINE.test(l));
				target = nextIndex >= 0 ? lines[nextIndex].trim() : '';
				const blankAfter = (lines[i + 1] ?? '').trim() === '';
				scope = topComments && blankAfter ? 'file' : 'block';
			}
			out.push({ path, line: i + 1, kind: m.kind, note: m.note.replace(/[:\-–]\s*$/, '').trim(), scope, target: target.slice(0, 120) });
		}
		if (!blank && !ownLine) topComments = false;
	});
	return out;
}

/** The files under `cwd` that may hold a marker: `git grep` in a repository, `grep -r` outside one. */
export function candidateFiles(cwd: string): string[] {
	const run = (cmd: string, args: string[]) => {
		try {
			return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024 });
		} catch (e) {
			// grep exits 1 when nothing matches.
			return (e as { status?: number; stdout?: string }).status === 1 ? '' : undefined;
		}
	};
	const pattern = 'AI[!?]';
	const out =
		run('git', ['grep', '-l', '-I', '--untracked', '-E', pattern]) ??
		run('grep', ['-rlI', '-E', pattern, '--exclude-dir=node_modules', '--exclude-dir=.git', '.']) ??
		'';
	return out
		.split('\n')
		.filter((f) => f !== '')
		.map((f) => (isAbsolute(f) ? f : join(cwd, f.replace(/^\.\//, ''))));
}

/** Every marker under `cwd`, plus those in `extra` (the file the editor just saved, which may be elsewhere). */
export function findMarkers(cwd: string, extra: string[] = []): Marker[] {
	const files = [...new Set([...candidateFiles(cwd), ...extra])];
	return files.flatMap((f) => {
		try {
			return parseMarkers(f, readFileSync(f, 'utf-8'));
		} catch {
			return [];
		}
	});
}

/** The one message pi gets for all markers. */
export function suggestionMessage(markers: Marker[], cwd: string): string {
	const rel = (p: string) => (p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p);
	const items = markers.map((m) => {
		const reach = m.scope === 'line' ? 'this line' : m.scope === 'block' ? 'the block below' : 'the whole file';
		const head = `- ${rel(m.path)}:${m.line} AI${m.kind} (${reach}) ${m.note}`;
		return m.target ? `${head}\n  at: ${m.target}` : head;
	});
	return [
		'Suggestions from the editor. AI! = make this change. AI? = answer this question in your reply.',
		'Do each one, then delete its marker comment from the file.',
		'',
		...items,
	].join('\n');
}
