// Stub filling against a real ttt (test/e2e/stubs.sh types fill! and answers
// the proposal): a fake pi gets the fill, an edit outside the stub is
// blocked, the body goes in with a why, a proposal for a new import is
// accepted and the import goes in. Needs TTT_CONFIG_DIR.
import { join } from 'node:path';
import { FakePi, sleep } from '../../demo/fake-pi.ts';

const [dir] = process.argv.slice(2);
const file = join(dir, 'sample.ts');
const pi = new FakePi({ cwd: dir, log: (line) => console.log(line) });
await pi.start();
console.log(`owner: ${(await pi.waitOwner(5000)) ? 'this' : 'none'}`);
for (let i = 0; i < 100 && pi.inbox.length === 0; i++) await sleep(100);
console.log(`fill: ${pi.inbox[0]?.split('\n')[0] ?? 'none'}`);

await pi.beginTurn();
const outside = await pi.edit(file, [{ oldText: 'const LIMIT = 10;', newText: 'const LIMIT = 20;' }]);
console.log(`outside: ${outside.blocked ? 'blocked' : 'went in'}`);
const body = await pi.edit(
	file,
	[{ oldText: "\t// TODO(pi)\n\tthrow new Error('not written');", newText: "\tconst data = await readFile(path, 'utf8');\n\treturn sum(data.split('\\n').map(Number));" }],
	'Reads the whole file at once: the files are small.',
);
console.log(`body: ${body.blocked ? 'blocked' : 'went in'}`);
const answer = await pi.propose({ kind: 'dependency', target: 'lodash', what: 'Import sum from lodash.', why: 'It adds the numbers.' });
console.log(`answer: ${answer}`);
const imp = await pi.edit(file, [{ oldText: "import { helper } from './helper.ts';\n", newText: "import { helper } from './helper.ts';\nimport { sum } from 'lodash';\n" }]);
console.log(`import: ${imp.blocked ? 'blocked' : 'went in'}`);
await pi.endTurn();
await sleep(1500);
await pi.stop();
