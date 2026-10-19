import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT, find, listing, SCENARIOS } from '../demo/scenarios/index.ts';
import { applyOnDisk, CLI, FORMAT, STORE_CLEAR, STORE_COUNT, STORE_DONE, TEST } from '../demo/scenarios/task.ts';

const workspace = new URL('../demo/workspace', import.meta.url).pathname;

test('scenarios: unique names, a default, and guidance for each', () => {
	const names = SCENARIOS.map((s) => s.name);
	assert.equal(new Set(names).size, names.length);
	assert.ok(find(DEFAULT));
	for (const s of SCENARIOS) {
		assert.match(s.name, /^[a-z]+$/, s.name);
		assert.ok(s.title && s.about, `${s.name}: title and about`);
		assert.ok(s.try.length > 0, `${s.name}: what to try`);
		// Proof: a check here, or another script that covers the scenario.
		assert.ok(s.check || s.covered, `${s.name}: a check or a covering script`);
		if (s.check) assert.ok(s.check.expect.length > 0 && s.check.drive, `${s.name}: the check says what must show`);
	}
	for (const name of names) assert.ok(listing().includes(name));
});

test('task: the operations fit the workspace, in the order the scenarios use', () => {
	const dir = mkdtempSync(join(tmpdir(), 'symbiosis-task-'));
	try {
		cpSync(workspace, dir, { recursive: true });
		// Every edit finds its text, or applyOnDisk throws.
		applyOnDisk(dir, [FORMAT, STORE_DONE, STORE_COUNT, STORE_CLEAR, CLI, TEST]);
		assert.throws(() => applyOnDisk(dir, [CLI]), /no text to replace/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
