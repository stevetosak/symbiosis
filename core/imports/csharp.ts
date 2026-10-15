// C#: System, the file's own namespace root, and the PackageReference
// entries of the .csproj files at the root and one folder down.
import { type ImportPolicy, matches, under } from './policy.ts';
import type { Project } from './project.ts';

function packages(project: Project): string[] {
	const dirs = ['', ...project.list('').map((d) => `${d}/`)];
	return dirs.flatMap((dir) =>
		project
			.list(dir)
			.filter((f) => f.endsWith('.csproj'))
			.flatMap((f) => matches(project.read(dir + f), /<PackageReference\s+Include\s*=\s*"([^"]+)"/g)),
	);
}

function ownRoot(fileText: string): string | null {
	return /^\s*namespace\s+([\w]+)/m.exec(fileText)?.[1] ?? null;
}

/** `using static System.Math` and `using X = System.Text`: the namespace is the last name. */
export const csharp: ImportPolicy = {
	languages: ['csharp'],
	load(project) {
		const prefixes = ['System', ...packages(project)];
		return (spec, fileText) => {
			const root = ownRoot(fileText);
			return (root !== null && under(spec, root)) || prefixes.some((p) => under(spec, p));
		};
	},
};
