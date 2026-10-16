// pi's own `edit` and `write`, registered again under their names with two
// changes: a `why` argument (the reason for a choice that is not obvious; the
// editor shows it with the change), and one call at a time, so the guard
// (pi/fill.ts) checks each call against the file as the call before left it.
// The work is pi's own code: matching, line endings and the file queue stay
// pi's.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { createEditToolDefinition, createWriteToolDefinition } from '@earendil-works/pi-coding-agent';
import { absolutePath } from '../core/stream.ts';

export const WHY_DESCRIPTION =
	'Optional. One or two sentences on each choice in this change that is not obvious (error handling, I/O, shared state, retries, caching). The developer reads it next to the change.';

/** What the probe's writeFile throws: the call's file and text are in hand. */
class Probed extends Error {
	readonly path: string;
	readonly text: string;
	constructor(path: string, text: string) {
		super('probed');
		this.path = path;
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

/** What a write or edit would leave: its file (real path) and the file's text. */
export interface Planned {
	path: string;
	text: string;
}

/**
 * What a `write` or `edit` would leave, worked out by pi's own code with the
 * write taken away: the path is pi's (`@`, `~`, unicode spaces), matching and
 * line endings are pi's. Undefined when the call would fail (an edit's old
 * text is not in the file): pi then fails it and no guard is needed.
 */
export async function planned(tool: 'write' | 'edit', input: unknown, cwd: string): Promise<Planned | undefined> {
	const writeFile = async (path: string, text: string): Promise<void> => {
		throw new Probed(path, text);
	};
	const probe =
		tool === 'edit'
			? createEditToolDefinition(cwd, { operations: { readFile: (path) => readFile(path), access: async () => undefined, writeFile } })
			: createWriteToolDefinition(cwd, { operations: { mkdir: async () => undefined, writeFile } });
	try {
		const args = probe.prepareArguments ? probe.prepareArguments(input as never) : input;
		await probe.execute('probe', args as never, undefined, undefined, { cwd } as never);
		return undefined;
	} catch (error) {
		return error instanceof Probed ? { path: realPath(error.path), text: error.text } : undefined;
	}
}

/**
 * The real path of a file that may not exist yet: its nearest folder that
 * exists, with symlinks resolved, and the rest. The editor sends real paths;
 * pi's folder may be a symlink.
 */
export function realPath(path: string): string {
	const rest: string[] = [];
	let at = resolve(path);
	for (;;) {
		try {
			return join(realpathSync(at), ...rest.reverse());
		} catch {
			const parent = dirname(at);
			if (parent === at) return resolve(path);
			rest.push(basename(at));
			at = parent;
		}
	}
}

/** A path the agent names (a proposal's target), as pi's tools would read it, real. */
export function namedPath(path: string, cwd: string): string {
	return realPath(absolutePath(path.trim().replace(/^@/, ''), cwd));
}

/** The `why` of a call, when it gave one. */
export function whyOf(input: unknown): string | undefined {
	const why = (input as { why?: unknown })?.why;
	return typeof why === 'string' && why.trim() !== '' ? why.trim() : undefined;
}
