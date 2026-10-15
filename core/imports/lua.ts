// Lua: a module file in the project (`a.b` is a/b.lua or a/b/init.lua, at the
// root, in lua/ or in src/), and the dependencies of a rockspec.
import { type ImportPolicy, matches } from './policy.ts';
import type { Project } from './project.ts';

const ROOTS = ['', 'lua/', 'src/'];

function rocks(project: Project): Set<string> {
	const specs = project.list('').filter((f) => f.endsWith('.rockspec'));
	const blocks = specs.flatMap((f) => matches(project.read(f), /\bdependencies\s*=\s*\{([^}]*)\}/g));
	return new Set(blocks.flatMap((block) => matches(block, /["']([\w.-]+)/g)));
}

export const lua: ImportPolicy = {
	languages: ['lua'],
	load(project) {
		const deps = rocks(project);
		return (spec) => {
			const path = spec.replace(/\./g, '/');
			return deps.has(spec.split('.')[0]) || ROOTS.some((r) => project.exists(`${r}${path}.lua`) || project.exists(`${r}${path}/init.lua`));
		};
	},
};
