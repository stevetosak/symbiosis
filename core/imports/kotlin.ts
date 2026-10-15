// Kotlin: the standard library (kotlin, java, javax), the file's own package
// root, and the group ids in the Gradle build files. A package whose name is
// not under its group id (kotlinx.coroutines from org.jetbrains.kotlinx) does
// not resolve: the model proposes it and the developer accepts it.
import { type ImportPolicy, matches, under } from './policy.ts';
import type { Project } from './project.ts';

const STANDARD = ['kotlin', 'java', 'javax'];
const BUILD_FILES = ['build.gradle.kts', 'build.gradle'];

/** Every Gradle build file at the root and one folder down, and the version catalog. */
function buildTexts(project: Project): string[] {
	const dirs = ['', ...project.list('').map((d) => `${d}/`)];
	const files = dirs.flatMap((d) => BUILD_FILES.map((f) => d + f));
	return [...files, 'gradle/libs.versions.toml'].map((f) => project.read(f)).filter((t): t is string => t !== null);
}

function groups(project: Project): string[] {
	return buildTexts(project).flatMap((text) => [
		// "group:artifact:version" and module = "group:artifact"
		...matches(text, /["']([\w.-]+):[\w.-]+(?::[^"']*)?["']/g),
		// group = "com.example"
		...matches(text, /\bgroup\s*=\s*["']([\w.-]+)["']/g),
	]);
}

/** The first two parts of the file's package: `com.example` of `com.example.app`. */
function ownRoot(fileText: string): string | null {
	const pkg = /^\s*package\s+([\w.]+)/m.exec(fileText)?.[1];
	return pkg ? pkg.split('.').slice(0, 2).join('.') : null;
}

export const kotlin: ImportPolicy = {
	languages: ['kotlin'],
	load(project) {
		const prefixes = [...STANDARD, ...groups(project)];
		return (spec, fileText) => {
			const root = ownRoot(fileText);
			return (root !== null && under(spec, root)) || prefixes.some((p) => under(spec, p));
		};
	},
};
