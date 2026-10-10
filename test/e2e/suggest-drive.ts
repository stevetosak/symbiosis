// A fake pi for test/e2e/suggest.sh: starts a session, then waits until the
// ttt plugin asks it to send the markers, and prints the message pi would send.
import symbiosis from '../../pi/index.ts';

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
const sent: string[] = [];
const pi = {
	on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
	registerTool: () => {},
	sendUserMessage: (text: string, options?: unknown) => sent.push(`${JSON.stringify(options ?? null)}\n${text}`),
};
symbiosis(pi as never);
const ctx = { cwd: process.argv[2], isIdle: () => true };
for (const h of handlers.get('session_start') ?? []) await h({}, ctx);

const until = Date.now() + Number(process.argv[3] ?? 8000);
while (sent.length === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
for (const h of handlers.get('session_shutdown') ?? []) await h({}, ctx);
console.log(sent.length ? `sent:\n${sent.join('\n---\n')}` : 'sent: nothing');
