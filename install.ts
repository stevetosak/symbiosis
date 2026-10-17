// Installs this checkout on this machine, for work on symbiosis itself:
//   * the pi package: `pi install <this folder>` (pi loads it from here, no copy)
//   * the ttt plugin: a COPY in ~/.config/ttt/plugins/symbiosis. pi also does
//     this copy each time it starts, so this is only for the first time.
//   * the command: ~/.local/bin/symbiosis -> <this folder>/bin/symbiosis
//     (SYMBIOSIS_BIN_DIR changes the folder), as bin/setup.sh does for users.
//   * removes the old link ~/.pi/agent/extensions/symbiosis -> <repo>/pi, which
//     would load the extension a second time.
// Users install with install.sh or `pi install git:github.com/stevetosak/symbiosis`.
// Honours PI_CODING_AGENT_DIR, TTT_CONFIG_DIR and SYMBIOSIS_BIN_DIR. Usage: bin/run-node install.ts [--check]
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtPluginSource, planTttPlugin, type Step } from './pi/setup.ts';
import { pluginDir } from './core/channel/file.ts';

export { planTttPlugin, type Step };

/** The link an older install made. Removed only when it points into this checkout. */
export function planOldLink(extensionsDir: string, repo: string): Step {
	const link = join(extensionsDir, 'symbiosis');
	const what = `old pi extension link ${link}`;
	let target: string;
	try {
		if (!lstatSync(link).isSymbolicLink()) return { what, state: 'skip', why: 'exists and is not a link; remove it by hand' };
		target = readlinkSync(link);
	} catch {
		return { what, state: 'ok' };
	}
	if (resolve(extensionsDir, target) !== join(repo, 'pi')) return { what, state: 'skip', why: `links to ${target}; remove it by hand` };
	return { what, state: 'remove', run: () => unlinkSync(link) };
}

/**
 * True when pi's settings already list this package, by path or by the GitHub
 * URL. pi writes a local path relative to the settings file's folder (`base`).
 */
export function hasPackage(settings: unknown, repo: string, base = '/'): boolean {
	const list = (settings as { packages?: unknown })?.packages;
	if (!Array.isArray(list)) return false;
	return list.some((p) => {
		const source = typeof p === 'string' ? p : (p as { source?: unknown })?.source;
		if (typeof source !== 'string') return false;
		return resolve(base, source) === repo || /github\.com\/stevetosak\/symbiosis(\.git)?(@.*)?$/.test(source);
	});
}

/** The `symbiosis` command: a link in `binDir` to `target`. Anything else there is left alone. */
export function planCommandLink(binDir: string, target: string): Step {
	const link = join(binDir, 'symbiosis');
	const what = `command ${link}`;
	let current: string | undefined;
	try {
		if (!lstatSync(link).isSymbolicLink()) return { what, state: 'skip', why: 'exists and is not a link; remove it by hand' };
		current = readlinkSync(link);
	} catch {}
	if (current !== undefined && resolve(binDir, current) === target) return { what, state: 'ok' };
	return {
		what,
		state: current === undefined ? 'create' : 'update',
		why: `-> ${target}`,
		run: () => {
			mkdirSync(binDir, { recursive: true });
			if (current !== undefined) unlinkSync(link);
			symlinkSync(target, link);
		},
	};
}

export function planPiPackage(piDir: string, repo: string, pi = 'pi'): Step {
	const what = `pi package ${repo}`;
	let settings: unknown = {};
	try {
		settings = JSON.parse(readFileSync(join(piDir, 'settings.json'), 'utf-8'));
	} catch {}
	if (hasPackage(settings, repo, piDir)) return { what, state: 'ok' };
	return {
		what,
		state: 'create',
		run: () => {
			const r = spawnSync(pi, ['install', repo], { stdio: 'inherit' });
			if (r.status !== 0) throw new Error(`${pi} install ${repo} failed`);
		},
	};
}

if (import.meta.main) {
	const repo = dirname(fileURLToPath(import.meta.url));
	const piDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent');
	const binDir = process.env.SYMBIOSIS_BIN_DIR || join(homedir(), '.local', 'bin');
	const steps = [
		planOldLink(join(piDir, 'extensions'), repo),
		planPiPackage(piDir, repo),
		planTttPlugin(pluginDir(), builtPluginSource()),
		planCommandLink(binDir, join(repo, 'bin', 'symbiosis')),
	];
	const check = process.argv.includes('--check');
	for (const s of steps) {
		console.log(`${s.state.padEnd(6)} ${s.what}${s.why ? ` (${s.why})` : ''}`);
		if (!check) s.run?.();
	}
	if (steps.some((s) => s.state === 'skip')) process.exitCode = 1;
}
