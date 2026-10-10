// Installs symbiosis on this machine:
//   * the pi extension: a link ~/.pi/agent/extensions/symbiosis -> <repo>/pi
//   * the ttt plugin: a COPY in ~/.config/ttt/plugins/symbiosis (a ttt plugin
//     cannot read through a link out of its folder). Run again after changing
//     the plugin. ttt asks you to allow its permissions on the next start.
// Honours PI_CODING_AGENT_DIR and TTT_CONFIG_DIR. Usage: bin/run-node install.ts [--check]
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginDir } from './pi/stream.ts';

export type Step = { what: string; state: 'create' | 'update' | 'ok' | 'skip'; why?: string; run?: () => void };

/** The link pi loads the extension from. A path that exists and is not our link is left alone. */
export function planPiLink(extensionsDir: string, target: string): Step {
	const link = join(extensionsDir, 'symbiosis');
	const what = `pi extension ${link} -> ${target}`;
	let current: string | undefined;
	try {
		current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : '';
	} catch {
		return { what, state: 'create', run: () => (mkdirSync(extensionsDir, { recursive: true }), symlinkSync(target, link)) };
	}
	if (current === target) return { what, state: 'ok' };
	return { what, state: 'skip', why: current ? `links to ${current}` : 'exists and is not a link' };
}

/** The plugin files copied into ttt's plugin folder. Runtime files there (events, heartbeat) are kept. */
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

if (import.meta.main) {
	const repo = dirname(fileURLToPath(import.meta.url));
	const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
	const steps = [planPiLink(join(piDir, 'extensions'), join(repo, 'pi')), planTttPlugin(pluginDir(), join(repo, 'ttt', 'symbiosis'))];
	const check = process.argv.includes('--check');
	for (const s of steps) {
		console.log(`${s.state.padEnd(6)} ${s.what}${s.why ? ` (${s.why})` : ''}`);
		if (!check) s.run?.();
	}
	if (steps.some((s) => s.state === 'skip')) process.exitCode = 1;
}
