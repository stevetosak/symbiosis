// An idle fake pi for test/e2e/close.sh: it registers, then holds for the
// time in ms (the second argument). Needs TTT_CONFIG_DIR.
import { FakePi } from '../../demo/fake-pi.ts';

const [dir, hold] = process.argv.slice(2);
const pi = new FakePi({ cwd: dir, log: (line) => console.log(line) });
await pi.start();
console.log(`owner: ${(await pi.waitOwner(4000)) ? 'this' : 'none'}`);
await new Promise((r) => setTimeout(r, Number(hold)));
await pi.stop();
