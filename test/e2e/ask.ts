// A fake pi for test/e2e/ask.sh: it answers an ask side call with a set
// reply (links, terms) and prints what it was asked. Needs TTT_CONFIG_DIR.
// Usage: ask.ts <cwd> <ms>
import { FakePi, sleep } from '../../demo/fake-pi.ts';

const [cwd, ms] = process.argv.slice(2);

const REPLY = 'The loop runs `times` times.\nIt adds one each round.\nlinks:\n- the loop | code.ts:3\n- MDN for | https://developer.mozilla.org/docs/Web/JavaScript/Reference/Statements/for\n- gone | nowhere.ts:9\nterms:\n- accumulator\n- loop bound\n';

const pi = new FakePi({ cwd, name: 'ws', chunk: 6, stepMs: 10, answer: () => REPLY, thinkMs: 300, log: (line) => console.log(line) });
await pi.start();
await sleep(Number(ms));
await pi.stop();
console.log(`asked: ${pi.asked.length}`);
for (const p of pi.asked) {
	console.log(`  line: ${/The developer asks about lines? ([\d-]+)/.exec(p)?.[1]}; question: ${/Their question: (.*)/.exec(p)?.[1] ?? '-'}; word: ${/under the cursor: `(.*)`/.exec(p)?.[1] ?? '-'}; parent: ${/Earlier question: (.*)/.exec(p)?.[1] ?? '-'}`);
}
console.log(`agent got: ${pi.inbox.length}`);
