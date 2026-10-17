import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCoupon, formatPrice, type Item, subtotal, total } from './cart.ts';

const items: Item[] = [
	{ name: 'apple', category: 'fruit', cents: 120, quantity: 3 },
	{ name: 'bread', category: 'bakery', cents: 250, quantity: 1 },
];

test('subtotal', () => assert.equal(subtotal(items), 610));
test('total adds the tax', () => assert.equal(total(items), 732));
test('coupons', () => {
	assert.equal(applyCoupon(1000, 'SAVE10'), 900);
	assert.equal(applyCoupon(300, 'FLAT500'), 0);
	assert.equal(applyCoupon(1000, 'NOPE'), 1000);
});
test('formatPrice', () => assert.equal(formatPrice(1234), '12.34 EUR'));
