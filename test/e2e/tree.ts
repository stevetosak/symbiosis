// The file tree follows pi: a fake pi writes a file in the folder open in
// ttt, then, after test/e2e/tree.sh opened the "pi files" panel, a file
// outside it. Needs TTT_CONFIG_DIR.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { FakePi } from '../../demo/fake-pi.ts';

const [dir, other] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pi = new FakePi({ cwd: dir, chunk: 16, stepMs: 5, log: (line) => console.log(line) });
await pi.start();
console.log(`owner: ${(await pi.waitOwner(4000)) ? pi.owner() : 'none'}`);
await pi.beginTurn();
mkdirSync(join(dir, 'src/deep'), { recursive: true });
await pi.write('src/deep/a.ts', 'export const a = 1;\n');
await sleep(Number(process.env.GAP_MS ?? 4000));
mkdirSync(other, { recursive: true });
await pi.write(join(other, 'b.ts'), 'export const b = 2;\n');
await pi.edit(join(dir, 'src/deep/a.ts'), [{ oldText: 'a = 1', newText: 'a = 3' }]);
await pi.endTurn();
await sleep(Number(process.env.HOLD_MS ?? 6000));
await pi.stop();
