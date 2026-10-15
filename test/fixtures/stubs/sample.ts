import { readFile } from 'node:fs/promises';
import { helper } from './helper.ts';

const LIMIT = 10;

/** Sum the numbers in a file, one per line. */
export async function sumFile(path: string): Promise<number> {
	// TODO(pi)
	throw new Error('not written');
}

export class Cache {
	private size = 0;

	/** Keep the value for `key`. */
	put(key: string, value: number): void {
		// TODO(pi)
	}

	get(key: string): number {
		return helper(key, LIMIT);
	}
}
