// Import policies: in stub scope a new import line is allowed when it
// resolves to the project itself, the standard library, or a package the
// project's manifest declares. Anything else is a new dependency: the guard
// rejects it and the model must `propose` it. One policy per language; a
// language with no policy resolves nothing.
import { csharp } from './csharp.ts';
import { go } from './go.ts';
import { kotlin } from './kotlin.ts';
import { lua } from './lua.ts';
import type { ImportPolicy, Resolver } from './policy.ts';
import type { Project } from './project.ts';
import { python } from './python.ts';
import { typescript } from './typescript.ts';

const POLICIES: readonly ImportPolicy[] = [typescript, kotlin, csharp, go, python, lua];

const NOTHING: Resolver = () => false;

/** The resolver for a language, with the project's manifests read. */
export function resolverFor(language: string, project: Project): Resolver {
	return POLICIES.find((p) => p.languages.includes(language))?.load(project) ?? NOTHING;
}
