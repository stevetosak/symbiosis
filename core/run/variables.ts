// VSCode's variables in a configuration's strings:
//   ${workspaceFolder} ${workspaceFolderBasename} ${cwd} ${pathSeparator}
//   ${file} ${fileBasename} ${fileBasenameNoExtension} ${fileExtname}
//   ${fileDirname} ${relativeFile} ${relativeFileDirname} ${lineNumber}
//   ${env:NAME}
// An unknown variable is an error, and so is a ${file...} with no file open:
// a run with a half-made command line is worse than no run. In a shell line
// (expandShell) an unknown ${...} is the shell's (${PORT:-5000}), and the
// values are quoted for where they land: a file named `a'; rm -rf ~` stays a
// file name.
import { basename, dirname, extname, relative, sep } from 'node:path';
import { RunConfigError } from './config.ts';

export interface VariableContext {
	readonly folder: string;
	/** The file open in the editor, absolute. */
	readonly file?: string;
	readonly line?: number;
	readonly env: Readonly<Record<string, string | undefined>>;
}

const UNKNOWN = Symbol('unknown');
const FILE_VARIABLES = new Set([
	'file', 'fileBasename', 'fileBasenameNoExtension', 'fileExtname', 'fileDirname', 'fileDirnameBasename', 'relativeFile', 'relativeFileDirname',
]);

export function expand(text: string, ctx: VariableContext): string {
	return text.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
		const value = valueOf(name, ctx);
		if (value === UNKNOWN) throw new RunConfigError(`\${${name}} is not a variable symbiosis knows`);
		return value;
	});
}

/**
 * A shell line's variables: each value quoted for the place it is in (bare,
 * in '...' or in "..."); the ${...} symbiosis does not know stay for the shell.
 */
export function expandShell(text: string, ctx: VariableContext): string {
	let out = '';
	let quote: '' | "'" | '"' = '';
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '\\' && quote !== "'") {
			out += ch + (text[i + 1] ?? '');
			i++;
			continue;
		}
		if (ch === '$' && text[i + 1] === '{') {
			const end = text.indexOf('}', i + 2);
			const value = end < 0 ? UNKNOWN : valueOf(text.slice(i + 2, end), ctx);
			if (value !== UNKNOWN) {
				out += quoteFor(value, quote);
				i = end;
				continue;
			}
		}
		if (ch === "'" && quote !== '"') quote = quote === "'" ? '' : "'";
		else if (ch === '"' && quote !== "'") quote = quote === '"' ? '' : '"';
		out += ch;
	}
	return out;
}

function quoteFor(value: string, quote: '' | "'" | '"'): string {
	if (quote === "'") return value.replace(/'/g, `'\\''`);
	if (quote === '"') return value.replace(/[\\"$`]/g, '\\$&');
	return value === '' ? '' : /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function valueOf(name: string, ctx: VariableContext): string | typeof UNKNOWN {
	if (name.startsWith('env:')) return ctx.env[name.slice(4)] ?? '';
	switch (name) {
		case 'workspaceFolder':
		case 'workspaceRoot':
			return ctx.folder;
		case 'workspaceFolderBasename':
			return basename(ctx.folder);
		case 'cwd':
			return ctx.folder;
		case 'pathSeparator':
		case '/':
			return sep;
		case 'lineNumber':
			if (ctx.line === undefined) throw new RunConfigError('${lineNumber}: no file is open');
			return String(ctx.line);
	}
	const file = ctx.file;
	if (FILE_VARIABLES.has(name) && !file) throw new RunConfigError(`\${${name}}: no file is open`);
	switch (name) {
		case 'file':
			return file!;
		case 'fileBasename':
			return basename(file!);
		case 'fileBasenameNoExtension':
			return basename(file!, extname(file!));
		case 'fileExtname':
			return extname(file!);
		case 'fileDirname':
			return dirname(file!);
		case 'fileDirnameBasename':
			return basename(dirname(file!));
		case 'relativeFile':
			return relative(ctx.folder, file!);
		case 'relativeFileDirname':
			return relative(ctx.folder, dirname(file!));
	}
	return UNKNOWN;
}
