// The version of symbiosis: one number, in package.json. The ttt plugin
// manifest and the herdr plugin manifest carry the same number (release-please
// writes all three, and a test fails when they differ).
//
// Pure functions over text, so the tests need no file system and no network.

/** The files that carry the version, relative to the package root. */
export const VERSION_FILES = {
	package: 'package.json',
	plugin: 'ttt/symbiosis/plugin.ttt.json',
	herdr: 'herdr-plugin/herdr-plugin.toml',
} as const;

export type VersionFile = keyof typeof VERSION_FILES;

/** The version in a package.json or a ttt plugin manifest; undefined when there is none. */
export function jsonVersion(text: string): string | undefined {
	try {
		const version = (JSON.parse(text) as { version?: unknown }).version;
		return typeof version === 'string' ? version : undefined;
	} catch {
		return undefined;
	}
}

/** The top-level `version = "x"` of a TOML file; undefined when there is none. */
export function tomlVersion(text: string): string | undefined {
	return text.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
}

/** The `PROTOCOL = <n>` of the built plugin (plugin.lua); undefined when there is none. */
export function luaProtocol(text: string): number | undefined {
	const n = Number(text.match(/\bPROTOCOL\s*=\s*(\d+)/)?.[1]);
	return Number.isInteger(n) ? n : undefined;
}

/** A release number as three integers; undefined when the text is not `x.y.z` (a leading `v` is allowed). */
export function parseVersion(text: string): [number, number, number] | undefined {
	const m = text.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
	return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** Negative when a is older than b, positive when newer, 0 when equal. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return 0;
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

/** The newest release tag in the output of `git ls-remote --tags`; undefined when there is none. */
export function newestTag(lsRemote: string): string | undefined {
	let best: string | undefined;
	for (const line of lsRemote.split('\n')) {
		// Tags: `<sha>\trefs/tags/v1.2.3`; an annotated tag also lists `v1.2.3^{}`.
		const tag = line.match(/\trefs\/tags\/(v\d+\.\d+\.\d+)(?:\^\{\})?$/)?.[1];
		if (tag && (!best || compareVersions(tag, best) > 0)) best = tag;
	}
	return best;
}

/** The facts `symbiosis version` reports; every field may be missing. */
export interface VersionFacts {
	/** package.json next to the launcher. */
	version?: string;
	/** `git describe --tags --always` of the package, when it is a git clone. */
	describe?: string;
	/** The ttt plugin in this package, and the copy in ttt's plugin folder. */
	plugin?: { packaged?: string; installed?: string };
	/** PROTOCOL of this package, of the installed plugin.lua, and of each open pi session. */
	protocol: { packaged: number; installed?: number; sessions: { name: string; version: number }[] };
	/** The newest release tag on GitHub; only set by --check. */
	latest?: string;
	/** --check failed: the reason. */
	checkError?: string;
	checked: boolean;
}

/** The text `symbiosis version` prints. */
export function formatVersion(f: VersionFacts): string {
	const lines = [`symbiosis ${f.version ?? 'unknown'}${f.describe && f.describe !== `v${f.version}` ? ` (${f.describe})` : ''}`];
	const p = f.plugin;
	if (p?.installed === undefined) lines.push('ttt plugin: not installed (pi installs it at its next start)');
	else if (p.packaged && p.installed !== p.packaged) lines.push(`ttt plugin: ${p.installed}, the package has ${p.packaged}: start pi once, then run "Plugins: Reload" in ttt`);
	else lines.push(`ttt plugin: ${p.installed}`);
	const { packaged, installed, sessions } = f.protocol;
	if (installed !== undefined && installed !== packaged) lines.push(`protocol: ${packaged}, the installed plugin has ${installed}: run "Plugins: Reload" in ttt`);
	else lines.push(`protocol: ${packaged}`);
	for (const s of sessions) if (s.version !== packaged) lines.push(`pi ${s.name}: protocol ${s.version}, it runs older code: restart that pi`);
	if (f.checked) {
		if (f.checkError) lines.push(`update check failed: ${f.checkError}`);
		else if (!f.latest) lines.push('update check: no release is published yet');
		else if (f.version && compareVersions(f.latest, f.version) > 0) lines.push(`newer: ${f.latest}. Update: pi update`);
		else lines.push(`up to date (latest ${f.latest})`);
	}
	return lines.join('\n');
}
