// ctrl+k q and "waits for you": a fake pi starts a turn, shows a dialog for
// about 9 s (test/e2e/stop.sh takes a screenshot of the bar meanwhile),
// then works until ttt asks it to stop. Needs TTT_CONFIG_DIR.
import { FakePi } from '../../demo/fake-pi.ts';

const [dir] = process.argv.slice(2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pi = new FakePi({ cwd: dir, log: (line) => console.log(line) });
await pi.start();
console.log(`owner: ${(await pi.waitOwner(4000)) ? 'this' : 'none'}`);
await pi.beginTurn();
await sleep(500);
await pi.dialog('Allow this one call? rm -rf build');
console.log('dialog shown');
await sleep(9000);
await pi.dialogEnd();
console.log('dialog answered');
for (let i = 0; i < 80 && pi.aborts === 0; i++) await sleep(100);
console.log(`aborts: ${pi.aborts}`);
await pi.endTurn();
await sleep(1500);
await pi.stop();
