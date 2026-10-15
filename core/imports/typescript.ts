// TypeScript and JavaScript: relative paths, `node:` and Node's built-in
// modules, `#` subpath imports, and the packages in package.json. An
// absolute path does not resolve: it leaves the project.
import { builtinModules } from 'node:module';
import type { ImportPolicy } from './policy.ts';
import type { Project } from './project.ts';

const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
export function packageName(spec: string): string {
	const parts = spec.split('/');
	return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function declared(project: Project): Set<string> {
	const names = new Set<string>();
	try {
		const manifest = JSON.parse(project.read('package.json') ?? '{}') as Record<string, unknown>;
		for (const field of DEPENDENCY_FIELDS) {
			const deps = manifest[field];
			if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) names.add(name);
		}
		if (typeof manifest.name === 'string') names.add(manifest.name);
	} catch {
		// A package.json that does not parse declares nothing.
	}
	return names;
}

export const typescript: ImportPolicy = {
	languages: ['typescript', 'tsx'],
	load(project) {
		const packages = declared(project);
		const builtins = new Set(builtinModules);
		return (spec) =>
			spec.startsWith('.') ||
			spec.startsWith('#') ||
			spec.startsWith('node:') ||
			builtins.has(packageName(spec)) ||
			packages.has(packageName(spec));
	},
};
