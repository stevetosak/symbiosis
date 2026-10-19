import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pluginDir } from '../core/channel/file.ts';
import { absolutePath, firstLine } from '../core/call.ts';

test('paths, lines and the plugin folder', () => {
	assert.equal(absolutePath('~/x', '/w', '/h'), '/h/x');
	assert.equal(absolutePath('x', '/w', '/h'), '/w/x');
	assert.equal(absolutePath('/x', '/w', '/h'), '/x');
	assert.equal(firstLine('edit', { firstChangedLine: 7 }), 7);
	assert.equal(firstLine('write', { firstChangedLine: 7 }), 1);
	assert.equal(firstLine('edit', undefined), 1);
	assert.equal(pluginDir({}, '/h'), '/h/.config/ttt/plugins/symbiosis');
	assert.equal(pluginDir({ TTT_CONFIG_DIR: '/c' }, '/h'), '/c/plugins/symbiosis');
});
