// Python: Django's manage.py, pyproject [project.scripts] (and Poetry's),
// a main.py / app.py; run with uv or poetry when the project uses them,
// else with the project's .venv python, else python3.
import type { RunConfig } from '../config.ts';
import { cwdOf, type Folder, named, type Provider, sourceOf } from './provider.ts';

/** The names in a TOML table such as [project.scripts]: `name = "module:func"`. */
export function tomlTable(toml: string, table: string): string[] {
	const out: string[] = [];
	let inside = false;
	for (const line of toml.split(/\r?\n/)) {
		const s = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (s) {
			inside = s[1].trim() === table;
			continue;
		}
		const m = inside ? /^\s*["']?([\w.-]+)["']?\s*=/.exec(line) : null;
		if (m && !out.includes(m[1])) out.push(m[1]);
	}
	return out;
}

type Runner = { command: string; pre: string[] };

function runner(folder: Folder): Runner {
	if (folder.up('uv.lock') !== undefined) return { command: 'uv', pre: ['run'] };
	if (folder.up('poetry.lock') !== undefined) return { command: 'poetry', pre: ['run'] };
	return { command: '', pre: [] };
}

function python(folder: Folder): string {
	for (const venv of ['.venv', 'venv']) {
		if (folder.read(`${venv}/pyvenv.cfg`) !== undefined) return `${venv}/bin/python`;
	}
	return 'python3';
}

export const pythonProvider: Provider = {
	name: 'python',
	detect(folder: Folder): RunConfig[] {
		const out: RunConfig[] = [];
		const r = runner(folder);
		// With uv or poetry: `uv run python x.py`; else the venv's python.
		const py = (args: string[]): { command: string; args: string[] } =>
			r.command ? { command: r.command, args: [...r.pre, 'python', ...args] } : { command: python(folder), args };
		const add = (thing: string, file: string, cmd: { command: string; args: string[] }) =>
			out.push({ ...named('python', folder, thing), group: 'Python', ...cmd, ...cwdOf(folder), source: sourceOf(folder, file) });

		if (folder.files.has('manage.py')) {
			add('runserver', 'manage.py', py(['manage.py', 'runserver']));
			add('manage.py test', 'manage.py', py(['manage.py', 'test']));
		}
		const toml = folder.read('pyproject.toml');
		if (toml !== undefined) {
			const scripts = [...tomlTable(toml, 'project.scripts'), ...tomlTable(toml, 'tool.poetry.scripts')];
			for (const s of [...new Set(scripts)]) {
				// A console script is on the venv's PATH once the project is installed.
				add(s, 'pyproject.toml', r.command ? { command: r.command, args: [...r.pre, s] } : { command: s, args: [] });
			}
			if (/pytest/.test(toml)) add('pytest', 'pyproject.toml', py(['-m', 'pytest']));
		}
		for (const file of ['main.py', 'app.py', '__main__.py']) {
			if (folder.files.has(file) && !folder.files.has('manage.py')) add(file, file, py([file]));
		}
		return out;
	},
};
