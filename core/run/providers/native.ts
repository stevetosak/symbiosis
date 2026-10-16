// Compiled languages: Cargo binaries and examples, Go main packages, .NET
// projects that build a program (and their launchSettings.json profiles).
import { posix } from 'node:path';
import type { RunConfig } from '../config.ts';
import { parseJsonc } from '../config.ts';
import { cwdOf, type Folder, named, type Provider, sourceOf } from './provider.ts';

/** Cargo.toml → the binaries ([[bin]] names, or the package when src/main.rs is there). */
export function cargoBins(toml: string, hasMain: boolean): string[] {
	const out: string[] = [];
	let section = '';
	let pkg: string | undefined;
	for (const line of toml.split(/\r?\n/)) {
		const s = /^\s*\[\[?([\w.-]+)\]\]?/.exec(line);
		if (s) {
			section = s[1];
			continue;
		}
		const m = /^\s*name\s*=\s*"([^"]+)"/.exec(line);
		if (!m) continue;
		if (section === 'package') pkg = m[1];
		if (section === 'bin' && !out.includes(m[1])) out.push(m[1]);
	}
	if (hasMain && pkg && !out.includes(pkg)) out.unshift(pkg);
	return out;
}

/** A Go file of package main with a func main. */
export function isGoMain(text: string): boolean {
	return /^package\s+main\b/m.test(text) && /^func\s+main\s*\(\s*\)/m.test(text);
}

/** A .csproj/.fsproj that builds a program: OutputType Exe, or the Web or Worker SDK. */
export function isDotnetProgram(text: string): boolean {
	return /<OutputType>\s*(Exe|WinExe)\s*<\/OutputType>/i.test(text) || /Sdk="Microsoft\.NET\.Sdk\.(Web|Worker|BlazorWebAssembly)"/i.test(text);
}

/** launchSettings.json → the profiles that run the project (not IIS). */
export function launchProfiles(text: string): string[] {
	try {
		const data = parseJsonc(text, 'launchSettings.json') as { profiles?: Record<string, { commandName?: string }> };
		return Object.entries(data.profiles ?? {})
			.filter(([, p]) => p?.commandName === 'Project')
			.map(([name]) => name);
	} catch {
		return [];
	}
}

export const cargo: Provider = {
	name: 'cargo',
	detect(folder: Folder): RunConfig[] {
		const toml = folder.read('Cargo.toml');
		if (toml === undefined) return [];
		const src = folder.read(posix.join('src', 'main.rs')) !== undefined;
		const out: RunConfig[] = [];
		const base = { group: 'Cargo', command: 'cargo', ...cwdOf(folder), source: sourceOf(folder, 'Cargo.toml') };
		for (const bin of cargoBins(toml, src)) out.push({ ...named('cargo', folder, `run ${bin}`), ...base, args: ['run', '--bin', bin] });
		if (/^\s*\[package\]/m.test(toml)) out.push({ ...named('cargo', folder, 'test'), ...base, args: ['test'] });
		return out;
	},
};

export const go: Provider = {
	name: 'go',
	detect(folder: Folder): RunConfig[] {
		const goFiles = [...folder.files].filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).sort();
		const mod = folder.up('go.mod');
		if (mod === undefined) return [];
		const out: RunConfig[] = [];
		const modFolder = { ...folder, rel: mod };
		// The files of a folder are one package: the first one's package clause
		// says whether it is main (and its head is enough: big folders, big files).
		if (goFiles.length > 0 && /^package\s+main\b/m.test(folder.head(goFiles[0], 4096) ?? '')) {
			const pkg = mod === '' ? folder.rel : posix.relative(mod, folder.rel);
			const target = pkg === '' ? '.' : `./${pkg}`;
			out.push({ ...named('go', modFolder, `run ${target}`), group: 'Go', command: 'go', args: ['run', target], ...cwdOf(modFolder), source: sourceOf(folder, goFiles[0]) });
		}
		if (folder.files.has('go.mod')) {
			out.push({ ...named('go', folder, 'test ./...'), group: 'Go', command: 'go', args: ['test', './...'], ...cwdOf(folder), source: sourceOf(folder, 'go.mod') });
		}
		return out;
	},
};

export const dotnet: Provider = {
	name: 'dotnet',
	detect(folder: Folder): RunConfig[] {
		const out: RunConfig[] = [];
		for (const proj of [...folder.files].filter((f) => /\.(cs|fs|vb)proj$/.test(f)).sort()) {
			if (!isDotnetProgram(folder.read(proj) ?? '')) continue;
			const name = proj.replace(/\.\w+proj$/, '');
			const base = { group: '.NET', command: 'dotnet', ...cwdOf(folder), source: sourceOf(folder, proj) };
			out.push({ ...named('dotnet', folder, `run ${name}`), ...base, args: ['run', '--project', proj] });
			const settings = folder.read(posix.join('Properties', 'launchSettings.json'));
			for (const profile of settings ? launchProfiles(settings) : []) {
				if (profile === name) continue;
				out.push({ ...named('dotnet', folder, `run ${name} (${profile})`), ...base, args: ['run', '--project', proj, '--launch-profile', profile] });
			}
		}
		return out;
	},
};
