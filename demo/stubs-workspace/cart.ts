// A shopping cart. Prices are in cents.

export interface Item {
	name: string;
	category: string;
	cents: number;
	quantity: number;
}

const TAX_RATE = 0.2;

/** The sum of price times quantity of all items, in cents. */
export function subtotal(items: Item[]): number {
	// TODO(pi)
	throw new Error('not written');
}

/** The subtotal plus tax (TAX_RATE), rounded to whole cents. */
export function total(items: Item[]): number {
	// TODO(pi)
	throw new Error('not written');
}

/**
 * The total after a coupon code. Look the code up in a table of coupons
 * (SAVE10: 10% off, FLAT500: 500 cents off, never below 0) that the rest of
 * the module can use too. An unknown code changes nothing.
 */
export function applyCoupon(cents: number, code: string): number {
	// TODO(pi)
	throw new Error('not written');
}

/** Cents as money with an optional currency code, default "EUR": 1234 → "12.34 EUR". */
export function formatPrice(cents: number): string {
	// TODO(pi)
	throw new Error('not written');
}

/** The date of the order as "16 Oct 2026", with the date-fns package. */
export function formatOrderDate(date: Date): string {
	// TODO(pi)
	throw new Error('not written');
}

// Your turn: end the comment below with helpi! and pause.

// a function that groups the items by category and returns the subtotal per category

export const EMPTY: Item[] = [];
