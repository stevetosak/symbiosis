// Go: the standard library (its first path element has no dot), the
// module's own path, and the `require` entries of go.mod.
import { type ImportPolicy, matches, under } from './policy.ts';

export const go: ImportPolicy = {
	languages: ['go'],
	load(project) {
		const mod = project.read('go.mod');
		const own = matches(mod, /^module\s+(\S+)/gm);
		// `require x v1` and the lines of `require ( ... )`; not replace or exclude.
		const blocks = matches(mod, /^require\s*\(([^)]*)\)/gm).join('\n');
		const required = [...matches(mod, /^require\s+([^\s(]+)\s/gm), ...matches(blocks, /^\s*(\S+)\s+v/gm)];
		const prefixes = [...own, ...required];
		return (spec) => !spec.split('/')[0].includes('.') || prefixes.some((p) => under(spec, p, '/'));
	},
};
