// Keeps the ttt plugin in ttt's plugin folder the same as the one in this
// package. A ttt plugin cannot read through a link out of its folder, so the
// files are copied. Runtime files there (events, sessions, settings) are kept.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir } from './stream.ts';

export type Step = { what: string; state: 'create' | 'update' | 'remove' | 'ok' | 'skip'; why?: string; run?: () => void };

/** The plugin as it is in this package: `<package>/ttt/symbiosis`. */
export const PLUGIN_SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'ttt', 'symbiosis');

/** The plugin files copied into ttt's plugin folder. Only changed files are copied. */
export function planTttPlugin(dest: string, source: string): Step {
	const what = `ttt plugin ${dest}`;
	const files = readdirSync(source);
	const stale = files.filter((f) => !existsSync(join(dest, f)) || !readFileSync(join(dest, f)).equals(readFileSync(join(source, f))));
	if (stale.length === 0) return { what, state: 'ok' };
	const state = existsSync(dest) ? 'update' : 'create';
	return {
		what,
		state,
		why: stale.join(', '),
		run: () => {
			mkdirSync(dest, { recursive: true });
			for (const f of stale) copyFileSync(join(source, f), join(dest, f));
		},
	};
}

/**
 * Called when pi starts: copies the plugin when ttt's copy differs. Does
 * nothing when ttt has no config folder (ttt is not installed or never ran).
 * Returns the step that ran, or undefined when nothing changed.
 */
export function syncTttPlugin(env: NodeJS.ProcessEnv = process.env, home = homedir(), source = PLUGIN_SOURCE): Step | undefined {
	const dest = pluginDir(env, home);
	if (!existsSync(dirname(dirname(dest)))) return undefined;
	if (!existsSync(source)) return undefined;
	const step = planTttPlugin(dest, source);
	if (!step.run) return undefined;
	step.run();
	return step;
}
