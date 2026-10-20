import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareVersions, formatVersion, jsonVersion, luaProtocol, newestTag, parseVersion, tomlVersion, VERSION_FILES, type VersionFacts } from '../core/version.ts';
import { PROTOCOL } from '../core/protocol.ts';
import { gatherFacts, PACKAGE_ROOT, parseVersionArgs, type VersionDeps } from '../launcher/version.ts';

const root = PACKAGE_ROOT;
const read = (file: string) => readFileSync(join(root, file), 'utf-8');

test('one version: package.json, the ttt plugin and the herdr plugin carry the same number', () => {
	const found = {
		package: jsonVersion(read(VERSION_FILES.package)),
		plugin: jsonVersion(read(VERSION_FILES.plugin)),
		herdr: tomlVersion(read(VERSION_FILES.herdr)),
	};
	assert.ok(parseVersion(found.package ?? ''), `package.json has no x.y.z version: ${found.package}`);
	assert.deepEqual(found, { package: found.package, plugin: found.package, herdr: found.package });
});

test('release-please writes the same files and starts at the package version', () => {
	const config = JSON.parse(read('release-please-config.json'));
	const paths = (config.packages['.']['extra-files'] as { path: string }[]).map((f) => f.path).sort();
	assert.deepEqual(paths, [VERSION_FILES.herdr, VERSION_FILES.plugin].sort());
	assert.equal(JSON.parse(read('.release-please-manifest.json'))['.'], jsonVersion(read(VERSION_FILES.package)));
});

test('the protocol of the ttt plugin source is the protocol of core/protocol.ts', () => {
	assert.equal(luaProtocol(read('ttt/src/core/channel.lua')), PROTOCOL);
});

test('version text: json, toml and the built plugin', () => {
	assert.equal(jsonVersion('{"version":"1.2.3"}'), '1.2.3');
	assert.equal(jsonVersion('{"version":2}'), undefined);
	assert.equal(jsonVersion('not json'), undefined);
	assert.equal(tomlVersion('id = "x"\nversion = "0.4.1"\nmin_herdr_version = "0.9.0"\n'), '0.4.1');
	assert.equal(tomlVersion('min_herdr_version = "0.9.0"\n'), undefined);
	assert.equal(luaProtocol('local M = {\n\tPROTOCOL = 16, -- x\n}'), 16);
	assert.equal(luaProtocol('nothing'), undefined);
});

test('versions compare as numbers, not as text', () => {
	assert.deepEqual(parseVersion('v1.10.2'), [1, 10, 2]);
	assert.equal(parseVersion('main'), undefined);
	assert.ok(compareVersions('v0.10.0', '0.9.0') > 0);
	assert.ok(compareVersions('0.1.0', '0.1.1') < 0);
	assert.equal(compareVersions('1.0.0', 'v1.0.0'), 0);
});

test('the newest tag in git ls-remote output; annotated and odd tags are handled', () => {
	const out = [
		'aaa\trefs/tags/v0.2.0',
		'bbb\trefs/tags/v0.10.0',
		'ccc\trefs/tags/v0.10.0^{}',
		'ddd\trefs/tags/v0.9.9',
		'eee\trefs/tags/nightly',
		'fff\trefs/tags/v1.0.0-rc1',
	].join('\n');
	assert.equal(newestTag(out), 'v0.10.0');
	assert.equal(newestTag(''), undefined);
});

const facts = (over: Partial<VersionFacts> = {}): VersionFacts => ({
	version: '0.2.0',
	plugin: { packaged: '0.2.0', installed: '0.2.0' },
	protocol: { packaged: 17, installed: 17, sessions: [] },
	checked: false,
	...over,
});

test('formatVersion: all in step says so briefly', () => {
	assert.equal(formatVersion(facts()), 'symbiosis 0.2.0\nttt plugin: 0.2.0\nprotocol: 17');
});

test('formatVersion: a git describe is added only when it says more than the number', () => {
	assert.match(formatVersion(facts({ describe: 'v0.2.0-3-gabc' })), /^symbiosis 0\.2\.0 \(v0\.2\.0-3-gabc\)/);
	assert.doesNotMatch(formatVersion(facts({ describe: 'v0.2.0' })), /\(v0\.2\.0\)/);
});

test('formatVersion: an old plugin copy, an old protocol and an old pi session each say what to do', () => {
	const text = formatVersion(facts({ plugin: { packaged: '0.2.0', installed: '0.1.0' }, protocol: { packaged: 17, installed: 16, sessions: [{ name: 'api', version: 16 }, { name: 'ui', version: 17 }] } }));
	assert.match(text, /ttt plugin: 0\.1\.0, the package has 0\.2\.0: start pi once/);
	assert.match(text, /protocol: 17, the installed plugin has 16: run "Plugins: Reload"/);
	assert.match(text, /pi api: protocol 16, it runs older code: restart that pi/);
	assert.doesNotMatch(text, /pi ui/);
});

test('formatVersion: no plugin copy yet', () => {
	assert.match(formatVersion(facts({ plugin: { packaged: '0.2.0' }, protocol: { packaged: 17, sessions: [] } })), /ttt plugin: not installed/);
});

test('formatVersion: the update check says newer, up to date, none, or failed', () => {
	assert.match(formatVersion(facts({ checked: true, latest: 'v0.3.0' })), /newer: v0\.3\.0\. Update: pi update/);
	assert.match(formatVersion(facts({ checked: true, latest: 'v0.2.0' })), /up to date/);
	assert.match(formatVersion(facts({ checked: true })), /no release is published yet/);
	assert.match(formatVersion(facts({ checked: true, checkError: 'no network' })), /update check failed: no network/);
	assert.doesNotMatch(formatVersion(facts()), /update|newer/);
});

test('arguments: --check and -h; anything else is refused', () => {
	assert.deepEqual(parseVersionArgs([]), { check: false, help: false });
	assert.deepEqual(parseVersionArgs(['--check']), { check: true, help: false });
	assert.equal(parseVersionArgs(['-h']).help, true);
	assert.throws(() => parseVersionArgs(['--now']), /unknown argument --now/);
});

function deps(over: Partial<VersionDeps> = {}): VersionDeps {
	const dir = mkdtempSync(join(tmpdir(), 'sym-version-'));
	const pkg = join(dir, 'pkg');
	const plugin = join(dir, 'plugin');
	mkdirSync(join(pkg, 'ttt', 'symbiosis'), { recursive: true });
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(pkg, 'package.json'), '{"version":"0.2.0"}');
	writeFileSync(join(pkg, 'ttt', 'symbiosis', 'plugin.ttt.json'), '{"version":"0.2.0"}');
	writeFileSync(join(plugin, 'plugin.ttt.json'), '{"version":"0.1.0"}');
	writeFileSync(join(plugin, 'plugin.lua'), 'PROTOCOL = 16');
	return { root: pkg, plugin, sessions: () => [], isAlive: () => true, exec: () => '', check: false, ...over };
}

test('gatherFacts: reads the package, the installed plugin and the open sessions; dead sessions are left out', () => {
	const f = gatherFacts(
		deps({
			sessions: () => [
				{ name: 'live', version: 16, pid: 1 },
				{ name: 'dead', version: 9, pid: 2 },
			],
			isAlive: (pid) => pid === 1,
		}),
	);
	assert.equal(f.version, '0.2.0');
	assert.deepEqual(f.plugin, { packaged: '0.2.0', installed: '0.1.0' });
	assert.deepEqual(f.protocol, { packaged: PROTOCOL, installed: 16, sessions: [{ name: 'live', version: 16 }] });
	assert.equal(f.checked, false);
});

test('gatherFacts: without --check nothing asks the network; with it, the newest tag is read', () => {
	const calls: string[][] = [];
	const exec = (argv: string[]) => {
		calls.push(argv);
		return 'aaa\trefs/tags/v0.3.0\n';
	};
	gatherFacts(deps({ exec }));
	assert.deepEqual(calls, []);
	const f = gatherFacts(deps({ exec, check: true }));
	assert.equal(f.latest, 'v0.3.0');
	assert.deepEqual(calls[0].slice(0, 3), ['git', 'ls-remote', '--tags']);
});

test('gatherFacts: a failed check is reported, not thrown', () => {
	const f = gatherFacts(
		deps({
			check: true,
			exec: () => {
				throw Object.assign(new Error('x'), { stderr: 'fatal: could not resolve host\n' });
			},
		}),
	);
	assert.equal(f.checkError, 'fatal: could not resolve host');
	assert.equal(f.latest, undefined);
});
