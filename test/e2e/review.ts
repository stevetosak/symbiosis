// Review per stub against a real ttt (test/e2e/review.sh types helpi! and
// the keys): a fake pi gets the fill, writes the body with a why, and ends
// its turn: the body lands in the session record. The editor opens the drawer
// by itself; the test reads the record before and after the developer's ack.
// Needs TTT_CONFIG_DIR.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakePi, sleep } from '../../demo/fake-pi.ts';
import { pluginDir } from '../../core/channel/file.ts';

const [dir] = process.argv.slice(2);
const file = join(dir, 'sample.ts');
const pi = new FakePi({ cwd: dir, log: (line) => console.log(line) });
await pi.start();
console.log(`owner: ${(await pi.waitOwner(5000)) ? 'this' : 'none'}`);
for (let i = 0; i < 100 && pi.inbox.length === 0; i++) await sleep(100);
console.log(`fill: ${pi.inbox[0]?.split('\n')[0] ?? 'none'}`);

const record = () => JSON.parse(readFileSync(join(pluginDir(), 'sessions', `${pi.sessionId()}.json`), 'utf-8'));
await pi.beginTurn();
const body = await pi.edit(
	file,
	[{ oldText: "\t// TODO(pi)\n\tthrow new Error('not written');", newText: "\tconst data = await readFile(path, 'utf8');\n\treturn data.split('\\n').map(Number).reduce((a, b) => a + b, 0);" }],
	'Reads the whole file at once: the files are small.',
);
console.log(`body: ${body.blocked ? 'blocked' : 'went in'}`);
await pi.endTurn();
const landed = record().review as { name: string; whys: string[] }[];
console.log(`landed: ${landed.map((l) => l.name).join(',') || 'none'} (${landed[0]?.whys.join('|') ?? ''})`);
// The developer reads the drawer, hides it, shows it again, and presses a.
for (let i = 0; i < 300 && record().review.length > 0; i++) await sleep(100);
console.log(`acked: ${record().review.length === 0 ? 'yes' : 'no'}`);
await sleep(1000);
await pi.stop();
