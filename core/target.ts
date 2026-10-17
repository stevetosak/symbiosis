// What a fill works on: a stub's body (core/stubs.ts), or the place for a new
// function under its description (core/place.ts). How messages name it.
import { type PlaceRef, placeTitle } from './place.ts';
import type { StubRef } from './stubs.ts';

export type FillTarget = StubRef | PlaceRef;

/** The target in a sentence: "the stub `put`", "the new function `f` under the description at line 12". */
export function targetText(target: FillTarget): string {
	if (target.kind === 'stub') return `the stub \`${target.name || 'anonymous'}\``;
	const name = target.name ? ` \`${target.name}\`` : '';
	return `the new function${name} under the description at line ${target.line}`;
}

/** The target's short name: for the status bar and the proposals. */
export function targetName(target: FillTarget): string {
	if (target.kind === 'stub') return target.name || 'anonymous';
	return target.name || placeTitle(target);
}

/** What the agent may change, as one instruction. */
export function stayInside(target: FillTarget): string {
	if (target.kind === 'stub') return `Edit only inside the body of \`${target.name || 'anonymous'}\`.`;
	return 'Change only the new function directly under its description (no blank line between), and add the import lines it needs.';
}
