// Python: relative imports, the standard library (asked of python3 itself,
// `sys.stdlib_module_names`), a module or package at the project root or in
// src/, and the dependencies in requirements*.txt and pyproject.toml. A
// distribution whose import name differs (PyYAML gives yaml) does not resolve.
import { type ImportPolicy, matches } from './policy.ts';
import type { Project } from './project.ts';

const STDLIB_SCRIPT = 'import sys; print("\\n".join(sorted(sys.stdlib_module_names)))';

/** A distribution name as an import name: `Foo-Bar` → `foo_bar`. */
const normal = (name: string) => name.toLowerCase().replace(/[-.]/g, '_');

/** The TOML tables of a file: `[name]` → its lines. */
function tables(toml: string | null): Map<string, string> {
	const out = new Map<string, string>();
	let name = '';
	for (const line of (toml ?? '').split('\n')) {
		const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
		if (header) name = header[1].trim();
		else out.set(name, `${out.get(name) ?? ''}${line}\n`);
	}
	return out;
}

/** The quoted names in the arrays of `text`: `"Flask>=2"` → Flask. */
const arrayItems = (text: string) => matches(text, /["']([A-Za-z0-9][\w.-]*)/g);

function dependencies(project: Project): string[] {
	const requirements = project.list('').filter((f) => /^requirements.*\.txt$/.test(f));
	const fromRequirements = requirements.flatMap((f) => matches(project.read(f), /^\s*([A-Za-z0-9][\w.-]*)/gm));
	const found: string[] = [];
	for (const [table, body] of tables(project.read('pyproject.toml'))) {
		// PEP 621: `dependencies = [...]`, and every array of the optional ones and of the groups.
		if (table === 'project') found.push(...matches(body, /^dependencies\s*=\s*\[([^\]]*)\]/gm).flatMap(arrayItems));
		if (table === 'project.optional-dependencies' || table === 'dependency-groups') found.push(...arrayItems(body));
		// Poetry: `name = "^1"` in the dependencies tables.
		if (/^tool\.poetry\.(group\.[\w-]+\.)?(dev-)?dependencies$/.test(table)) found.push(...matches(body, /^([A-Za-z0-9][\w.-]*)\s*=/gm));
	}
	return [...fromRequirements, ...found].map(normal);
}

/** A module or a package at the root or in src/: `name.py`, or a folder that holds Python files. */
function ownModule(project: Project, name: string): boolean {
	return ['', 'src/'].some((dir) => project.exists(`${dir}${name}.py`) || project.list(`${dir}${name}`).some((f) => f.endsWith('.py')));
}

export const python: ImportPolicy = {
	languages: ['python'],
	load(project) {
		const stdlib = new Set((project.run('python3', ['-c', STDLIB_SCRIPT]) ?? '').split('\n').filter(Boolean));
		const deps = new Set(dependencies(project));
		return (spec) => {
			if (spec.startsWith('.')) return true;
			const top = spec.split('.')[0];
			return stdlib.has(top) || deps.has(normal(top)) || ownModule(project, top);
		};
	},
};
