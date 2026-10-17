import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, bundle, collect, ensureBundle, OUT } from '../ttt/build.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const luajit = spawnSync('luajit', ['-v']).status === 0;

test('ensureBundle writes the bundle when it is missing or old, and only then', () => {
	const dir = mkdtempSync(join(tmpdir(), 'symbiosis-bundle-'));
	try {
		const out = join(dir, 'plugin.lua');
		assert.equal(ensureBundle(out), true);
		assert.equal(readFileSync(out, 'utf8'), build());
		assert.equal(ensureBundle(out), false);
		writeFileSync(out, 'old');
		assert.equal(ensureBundle(out), true);
		assert.equal(readFileSync(out, 'utf8'), build());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the bundle: modules by path, the line map points at each source', () => {
	const dir = mkdtempSync(join(tmpdir(), 'symbiosis-build-'));
	try {
		mkdirSync(join(dir, 'core'));
		writeFileSync(join(dir, 'core', 'x.lua'), 'return { n = 1 }\n');
		writeFileSync(join(dir, 'main.lua'), 'local x = require("core.x")\nreturn x\n');
		const modules = collect(dir, dir);
		assert.deepEqual(modules.map((m) => [m.name, m.file]), [['core.x', 'core/x.lua'], ['main', 'main.lua']]);
		const lines = bundle(modules).split('\n');
		for (const m of modules) {
			const entry = lines.find((l) => l.endsWith(`  ${m.file}`));
			assert.ok(entry, m.file);
			const at = Number(entry.slice(2).trim().split(/\s+/)[0]);
			assert.equal(lines[at - 1], m.source.split('\n')[0], m.file);
		}
		writeFileSync(join(dir, 'Bad.lua'), '');
		assert.throws(() => collect(dir, dir), /lower case/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test('the bundle needs main.lua', () => {
	assert.throws(() => bundle([{ name: 'core.x', file: 'x.lua', source: '' }]), /main\.lua/);
});

test('the Lua unit tests (test/lua, under luajit)', { skip: !luajit && 'luajit is not installed' }, () => {
	ensureBundle();
	const run = spawnSync('luajit', ['test/lua/run.lua', '.'], { cwd: root, encoding: 'utf8' });
	assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('the bundle is valid Lua 5.1', { skip: !luajit && 'luajit is not installed' }, () => {
	ensureBundle();
	const run = spawnSync('luajit', ['-b', OUT, '/dev/null'], { encoding: 'utf8' });
	assert.equal(run.status, 0, run.stderr);
});
