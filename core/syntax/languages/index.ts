// Every language symbiosis knows. A new language: one file next to this one,
// and one entry here.
import type { LanguageSpec } from '../language.ts';
import { csharp } from './csharp.ts';
import { go } from './go.ts';
import { kotlin } from './kotlin.ts';
import { lua } from './lua.ts';
import { python } from './python.ts';
import { tsx, typescript } from './typescript.ts';

export const LANGUAGES: readonly LanguageSpec[] = [typescript, tsx, kotlin, csharp, go, python, lua];

/** The language of a file, by its name; undefined when symbiosis does not know it. */
export function languageOf(path: string): LanguageSpec | undefined {
	const lower = path.toLowerCase();
	return LANGUAGES.find((l) => l.extensions.some((e) => lower.endsWith(e)));
}
