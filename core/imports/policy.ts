// What an import policy is, and the helpers the policies share. The
// policies are one file per language; ./index.ts lists them.
import type { Project } from './project.ts';

/** True when `spec`, imported in a file with text `fileText`, resolves. */
export type Resolver = (spec: string, fileText: string) => boolean;

export interface ImportPolicy {
	/** The language ids of core/syntax/languages that this policy serves. */
	languages: string[];
	/** Reads the manifests once. The resolver may still ask whether a module file exists. */
	load(project: Project): Resolver;
}

/** `spec` is `prefix` or starts with `prefix` and then `sep`. */
export function under(spec: string, prefix: string, sep = '.'): boolean {
	return spec === prefix || spec.startsWith(prefix + sep);
}

/** Every match of the first group of `pattern` in `text`. */
export function matches(text: string | null, pattern: RegExp): string[] {
	if (!text) return [];
	return [...text.matchAll(pattern)].map((m) => m[1]);
}
