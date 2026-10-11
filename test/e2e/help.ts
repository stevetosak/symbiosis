// A fake pi for test/e2e/help.sh: it answers helpi! questions with set
// replies, by a word in the question, and prints what it was asked and what
// went to its agent. Needs TTT_CONFIG_DIR. Usage: help.ts <cwd> <name> <ms>
import { FakePi, sleep } from '../../demo/fake-pi.ts';

const [cwd, name, ms] = process.argv.slice(2);

/** The comment line from the side call's prompt. */
const question = (prompt: string) => /The comment is line \d+:\n(.*)/.exec(prompt)?.[1] ?? '';

function answer(prompt: string): string {
	const q = question(prompt);
	if (q.includes('folder')) return "code\n+import import { mkdirSync } from 'node:fs';\nmkdirSync(dir, { recursive: true });\nwriteFileSync(dir + '/note.txt', text);\n";
	if (q.includes('why')) return 'note\nwriteFileSync takes a string or a Buffer.\nA string is simpler here.\n';
	if (q.includes('project')) return 'ask\n';
	if (q.includes('slow')) return `note\n${'This answer is long and slow. '.repeat(30)}\n`;
	return 'note\nI do not know.';
}

const pi = new FakePi({ cwd, name, chunk: 4, stepMs: 20, answer, thinkMs: 1000, log: (line) => console.log(line) });
await pi.start();
await sleep(Number(ms));
await pi.stop();
console.log(`asked: ${pi.asked.length}`);
for (const p of pi.asked) console.log(`  ${question(p)}`);
console.log(`agent got: ${pi.inbox.length}`);
for (const m of pi.inbox) console.log(m.split('\n').map((l) => `  | ${l}`).join('\n'));
