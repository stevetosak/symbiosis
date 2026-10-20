import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adler32, commonPrefix, Tracker } from '../core/stream.ts';

test('a write streams its content as growing text, sending only the change', () => {
	const t = new Tracker('c1', 'write');
	assert.equal(t.pathOf({ path: 'a.t' }, false), undefined, 'the path may still grow');
	assert.equal(t.pathOf({ path: 'a.ts', content: '' }, false), 'a.ts');
	assert.equal(t.pathOf({ content: 'x', path: 'a.t' }, false), undefined, 'path written last: it may still grow');
	assert.equal(t.pathOf({ content: 'x', path: 'a.ts' }, true), 'a.ts');
	assert.deepEqual(t.update({ path: 'a.ts', content: 'let x' }), [{ call: 'c1', op: 'text', key: 'content', from: 0, text: 'let x' }]);
	assert.deepEqual(t.update({ path: 'a.ts', content: 'let x = 1;' }), [{ call: 'c1', op: 'text', key: 'content', from: 5, text: ' = 1;' }]);
	assert.deepEqual(t.update({ path: 'a.ts', content: 'let x = 1;' }), []);
});

test('from counts UTF-8 bytes, which is what the Lua plugin indexes', () => {
	const t = new Tracker('c1', 'write');
	t.update({ content: 'é' });
	assert.deepEqual(t.update({ content: 'éa' }), [{ call: 'c1', op: 'text', key: 'content', from: 2, text: 'a' }]);
});

test('a partial escape that changes earlier text sends from the common prefix', () => {
	const t = new Tracker('c1', 'write');
	t.update({ content: 'ab\\' });
	assert.deepEqual(t.update({ content: 'ab\n' }), [{ call: 'c1', op: 'text', key: 'content', from: 2, text: '\n' }]);
});

test('an edit sends oldText once, complete, then streams newText', () => {
	const t = new Tracker('c2', 'edit');
	assert.deepEqual(t.update({ path: 'a', edits: [{ oldText: 'fo' }] }), [], 'oldText may still grow');
	assert.deepEqual(new Tracker('c3', 'edit').update({ path: 'a', edits: [{ newText: 'b', oldText: 'fo' }] }), [], 'oldText written last: it may still grow');
	assert.deepEqual(t.update({ path: 'a', edits: [{ oldText: 'foo', newText: 'b' }] }), [
		{ call: 'c2', op: 'text', key: 'edits.0.old', from: 0, text: 'foo' },
		{ call: 'c2', op: 'text', key: 'edits.0.new', from: 0, text: 'b' },
	]);
	assert.deepEqual(t.update({ path: 'a', edits: [{ oldText: 'foo', newText: 'bar' }, { oldText: 'x' }] }), [
		{ call: 'c2', op: 'text', key: 'edits.0.new', from: 1, text: 'ar' },
	]);
	assert.deepEqual(t.update({ path: 'a', edits: [{ oldText: 'foo', newText: 'bar' }, { oldText: 'x' }] }, true), [
		{ call: 'c2', op: 'text', key: 'edits.1.old', from: 0, text: 'x' },
	]);
});

test('commonPrefix never splits a surrogate pair', () => {
	assert.equal(commonPrefix('a😀', 'a😁'), 1);
	assert.equal(commonPrefix('abc', 'abd'), 2);
});

test('adler32 matches the known value', () => {
	assert.equal(adler32(Buffer.from('Wikipedia')), 0x11e60398);
	assert.equal(adler32(Buffer.from('')), 1);
});
