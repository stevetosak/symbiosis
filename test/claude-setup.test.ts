import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planPluginDir, settingsPath, VARIABLE, withCopy } from '../claude/setup.mjs';

const repo = join(import.meta.dirname, '..');
const temp = () => realpathSync(mkdtempSync(join('/tmp', 'sbs-')));
const read = (file: string) => JSON.parse(readFileSync(file, 'utf-8'));

test('Claude Code settings: the folder of the settings, CLAUDE_CONFIG_DIR first', () => {
	assert.equal(settingsPath({}, '/home/me'), '/home/me/.claude/settings.json');
	assert.equal(settingsPath({ CLAUDE_CONFIG_DIR: '/c' }, '/home/me'), '/c/settings.json');
});

test('the plugin folders: this copy once, the user\'s other folders kept, another symbiosis copy replaced', () => {
	const copies = new Set(['/old/symbiosis', '/new/symbiosis']);
	const isCopy = (dir: string) => copies.has(dir);
	assert.equal(withCopy('', '/new/symbiosis', isCopy), '/new/symbiosis');
	assert.equal(withCopy('/mine/plugin', '/new/symbiosis', isCopy), '/mine/plugin:/new/symbiosis');
	assert.equal(withCopy('/mine/plugin:/new/symbiosis', '/new/symbiosis', isCopy), '/mine/plugin:/new/symbiosis');
	assert.equal(withCopy('/old/symbiosis: /mine/plugin', '/new/symbiosis', isCopy), '/mine/plugin:/new/symbiosis');
	assert.equal(withCopy('/new/symbiosis/', '/new/symbiosis', isCopy), '/new/symbiosis/', 'the same folder, written another way');
});

test('the settings file: created, updated with every other setting kept, then nothing to do', () => {
	const dir = temp();
	const file = join(dir, 'claude', 'settings.json');
	const create = planPluginDir(file, '/s/symbiosis', () => false);
	assert.equal(create.state, 'create');
	create.run?.();
	assert.deepEqual(read(file), { env: { [VARIABLE]: '/s/symbiosis' } });
	assert.equal(planPluginDir(file, '/s/symbiosis', () => false).state, 'ok');

	writeFileSync(file, JSON.stringify({ model: 'opus', env: { FOO: '1', [VARIABLE]: '/mine' }, hooks: { Stop: [] } }));
	const update = planPluginDir(file, '/s/symbiosis', () => false);
	assert.deepEqual({ state: update.state, why: update.why }, { state: 'update', why: `${VARIABLE}=/mine:/s/symbiosis` });
	update.run?.();
	assert.deepEqual(read(file), { model: 'opus', env: { FOO: '1', [VARIABLE]: '/mine:/s/symbiosis' }, hooks: { Stop: [] } });
});

test('the settings file: a link stays a link; a broken or odd file is left alone', () => {
	const dir = temp();
	const real = join(dir, 'dotfiles', 'settings.json');
	mkdirSync(join(dir, 'dotfiles'));
	mkdirSync(join(dir, 'claude'));
	writeFileSync(real, '{"model":"opus"}');
	const link = join(dir, 'claude', 'settings.json');
	symlinkSync(real, link);
	planPluginDir(link, '/s/symbiosis', () => false).run?.();
	assert.equal(readlinkSync(link), real);
	assert.deepEqual(read(real), { model: 'opus', env: { [VARIABLE]: '/s/symbiosis' } });

	for (const [text, why] of [
		['{"model": "opus",}', /not valid JSON; add \/s\/symbiosis to env\.CLAUDE_CODE_PLUGIN_DIRS by hand/],
		['[]', /not a settings object/],
		['{"env": "x"}', /not a settings object/],
		['{"env": {"CLAUDE_CODE_PLUGIN_DIRS": 3}}', /is not a string/],
	] as const) {
		writeFileSync(real, text);
		const step = planPluginDir(link, '/s/symbiosis', () => false);
		assert.equal(step.state, 'skip', text);
		assert.match(step.why ?? '', why);
		assert.equal(readFileSync(real, 'utf-8'), text);
	}
	assert.equal(planPluginDir(link, 'relative/symbiosis').state, 'skip');
	assert.equal(planPluginDir(link, '/a:b/symbiosis').state, 'skip');
});

test('node claude/setup.mjs: this checkout goes into the settings of CLAUDE_CONFIG_DIR', () => {
	const dir = temp();
	const run = () => spawnSync(process.execPath, [join(repo, 'claude', 'setup.mjs')], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, encoding: 'utf-8' });
	const first = run();
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /Claude Code loads symbiosis from /);
	assert.equal(read(join(dir, 'settings.json')).env[VARIABLE], realpathSync(repo));
	run();
	assert.equal(read(join(dir, 'settings.json')).env[VARIABLE], realpathSync(repo), 'a second run adds nothing');
});
