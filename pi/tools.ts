// pi's own `edit` and `write`, registered again under their names with two
// changes: a `why` argument (the reason for a choice that is not obvious; the
// editor shows it with the change), and one call at a time, so the guard
// (pi/fill.ts) checks each call against the file as the call before left it.
// The work is pi's own code: matching, line endings and the file queue stay
// pi's.
import { readFile } from 'node:fs/promises';
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import { absolutePath } from '../core/stream.ts';

export const WHY_DESCRIPTION =
	'Optional. One or two sentences on each choice in this change that is not obvious (error handling, I/O, shared state, retries, caching). The developer reads it next to the change.';

/** What the probe's writeFile throws: the text it would write is in hand. */
class Probed extends Error {
	readonly text: string;
	constructor(text: string) {
		super('probed');
		this.text = text;
	}
}

type Definition = ReturnType<typeof createEditToolDefinition> | ReturnType<typeof createWriteToolDefinition>;

/** A tool's definition with `why` added to its arguments and taken off before pi's code runs. */
function withWhy<D extends Definition>(definition: D): D {
	const parameters = definition.parameters as unknown as { properties: Record<string, unknown> };
	return {
		...definition,
		parameters: { ...parameters, properties: { ...parameters.properties, why: { type: 'string', description: WHY_DESCRIPTION } } },
		promptGuidelines: [...(definition.promptGuidelines ?? []), `Give ${definition.name} a \`why\` when a choice in the change is not obvious.`],
		executionMode: 'sequential',
		execute(id: string, params: Record<string, unknown>, ...rest: unknown[]) {
			const { why: _why, ...args } = params;
			return (definition.execute as (...a: unknown[]) => unknown)(id, args, ...rest);
		},
	} as unknown as D;
}

/** The `edit` and `write` tools to register in place of pi's. */
export function tools(cwd: string): Definition[] {
	return [withWhy(createEditToolDefinition(cwd)), withWhy(createWriteToolDefinition(cwd))];
}

/**
 * The text an `edit` would leave in its file, worked out by pi's own edit
 * code with the write taken away. Undefined when the edit would fail (its old
 * text is not in the file): pi then fails it and no guard is needed.
 */
export async function editResult(input: unknown, cwd: string): Promise<string | undefined> {
	const probe = createEditToolDefinition(cwd, {
		operations: {
			readFile: (path) => readFile(path),
			access: async () => undefined,
			writeFile: async (_path, text) => {
				throw new Probed(text);
			},
		},
	});
	try {
		const args = probe.prepareArguments ? probe.prepareArguments(input) : input;
		await probe.execute('probe', args as never, undefined, undefined, { cwd } as never);
		return undefined;
	} catch (error) {
		return error instanceof Probed ? error.text : undefined;
	}
}

/** The path a write or edit call names, absolute; undefined when it names none. */
export function pathOf(input: unknown, cwd: string): string | undefined {
	const path = (input as { path?: unknown })?.path;
	return typeof path === 'string' && path !== '' ? absolutePath(path, cwd) : undefined;
}

/** The `why` of a call, when it gave one. */
export function whyOf(input: unknown): string | undefined {
	const why = (input as { why?: unknown })?.why;
	return typeof why === 'string' && why.trim() !== '' ? why.trim() : undefined;
}
