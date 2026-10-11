import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from './store.ts';

test('add gives each to-do the next id', () => {
	const store = new Store();
	assert.equal(store.add('buy milk').id, 1);
	assert.equal(store.add('call mum').id, 2);
	assert.deepEqual(
		store.list().map((t) => t.text),
		['buy milk', 'call mum'],
	);
});
