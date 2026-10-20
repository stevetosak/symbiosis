// The preview runs behind pi: a fake pi makes five changes in two files at
// full speed, while the headless ttt of test/e2e/preview.sh types them
// slowly. pi never waits for the editor. Needs TTT_CONFIG_DIR.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakePi } from '../../demo/fake-pi.ts';

const dir = process.argv[2];
const pi = new FakePi({ cwd: dir, chunk: 16, stepMs: 5, log: (line) => console.log(line) });
await pi.start();
console.log(`owner: ${(await pi.waitOwner(4000)) ? pi.owner() : 'none'}`);
await pi.beginTurn();
const t = Date.now();
const a = join(dir, 'a.ts');
await pi.edit(a, [{ oldText: 'export const one = 1;', newText: 'export const one = 1;\nexport const two = 2;' }]);
await pi.edit(a, [{ oldText: 'export const two = 2;', newText: 'export const two = 2;\nexport const three = 3;' }]);
await pi.write('b.ts', "import { one } from './a.ts';\n\nexport const sum = one + 1;\n");
await pi.edit(a, [{ oldText: 'export const three = 3;', newText: 'export const three = 3;\nexport const four = 4;' }]);
await pi.edit(a, [{ oldText: '// a', newText: '// a: numbers' }]);
const ms = Date.now() - t;
console.log(`pi made 5 changes in ${(ms / 1000).toFixed(1)} s`);
if (ms > 3000) console.log('FAIL: pi waited for the editor');
await pi.endTurn();
writeFileSync(join(dir, 'pi-done'), '');
// The session stays, so the editor keeps following it while the preview ends.
await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS ?? 15000)));
await pi.stop();
