// The change list in the plan drawer: a fake pi plans two steps with files,
// writes a file it named and one it did not, and ttt shows them under their
// steps (test/e2e/changelist.sh drives ttt and reads the screen). Needs TTT_CONFIG_DIR.
import { join } from 'node:path';
import { FakePi } from '../../demo/fake-pi.ts';

const [dir] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pi = new FakePi({ cwd: dir, log: (line) => console.log(line) });
await pi.start();
console.log(`owner: ${(await pi.waitOwner(4000)) ? 'this' : 'none'}`);
await pi.beginTurn();
await pi.plan(['Write the store', 'now', ['store.ts', 'store.test.ts']], ['Document it', 'next', ['README.md']]);
await pi.write(join(dir, 'store.ts'), 'export const store = new Map();\n', 'the store is a Map');
await pi.write(join(dir, 'extra.ts'), 'export const extra = 1;\n');
console.log('written');
await sleep(18000);
await pi.endTurn();
await pi.stop();
