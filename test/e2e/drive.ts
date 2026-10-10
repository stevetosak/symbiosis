// Drives the pi extension (pi/index.ts) with a fake pi, as a model would:
// arguments arrive in small JSON chunks, parsed by pi's own partial parser.
// The real tool step is played here too (write the file, then tool_result).
// Used by test/e2e/run.sh against a headless ttt. Needs TTT_CONFIG_DIR.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import symbiosis from '../../pi/index.ts';

const parser = join(homedir(), '.pi/agent/install/releases/1.1.0/node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js');
const { parseStreamingJson } = (await import(parser)) as { parseStreamingJson: (s: string) => Record<string, unknown> };

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
type Tool = { execute: (id: string, params: unknown) => Promise<unknown> };
const tools = new Map<string, Tool>();
const pi = {
	on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
	registerTool: (t: Tool & { name: string }) => tools.set(t.name, t),
};
symbiosis(pi as never);

const ctx = { cwd: process.argv[2], isIdle: () => true };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function fire(name: string, event: unknown) {
	for (const h of handlers.get(name) ?? []) await h(event, ctx);
}

const CHUNK = Number(process.env.CHUNK ?? 8);
const STEP_MS = Number(process.env.STEP_MS ?? 25);

/** Streams one tool call, then runs it with `run`, like pi does. */
async function call(id: string, name: 'write' | 'edit', args: Record<string, unknown>, run: () => unknown) {
	const json = JSON.stringify(args);
	for (let i = CHUNK; i < json.length + CHUNK; i += CHUNK) {
		const partial = { content: [{ type: 'toolCall', id, name, arguments: parseStreamingJson(json.slice(0, i)) }] };
		await fire('message_update', { assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '', partial } });
		await sleep(STEP_MS);
	}
	await fire('message_update', { assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id, name, arguments: args } } });
	const t = Date.now();
	await fire('tool_call', { toolCallId: id, toolName: name, input: args });
	console.log(`${id}: tool_call waited ${Date.now() - t} ms`);
	const details = run();
	await fire('tool_result', { toolCallId: id, toolName: name, input: args, isError: false, details });
}

const dir = process.argv[2];
const a = join(dir, 'todo.ts');
await fire('session_start', {});
// The plugin picks this session as the owner within a second or so.
const owned = Date.now() + 4000;
const owner = () => {
	try {
		return JSON.parse(readFileSync(join(process.env.TTT_CONFIG_DIR ?? '', 'plugins/symbiosis/ttt.json'), 'utf-8')).owner;
	} catch {
		return undefined;
	}
};
while (!owner() && Date.now() < owned) await sleep(100);
console.log(`owner: ${owner() ?? 'none'}`);
await fire('agent_start', {});
/** The model calls the plan tool: here, straight to execute. */
const plan = (...steps: [string, 'done' | 'now' | 'next'][]) => tools.get('plan')?.execute('p', { steps: steps.map(([text, state]) => ({ text, state })) });
await plan(['Write the to-do store', 'now'], ['Add done() to the store', 'next'], ['Note that ids start at 1', 'next'], ['Run the tests', 'next'], ['Update the README', 'next']);
await sleep(1200);
await call('c1', 'write', { path: 'todo.ts', content: readFileSync(new URL('./todo-v1.ts', import.meta.url), 'utf-8') }, () => {
	writeFileSync(a, readFileSync(new URL('./todo-v1.ts', import.meta.url), 'utf-8'));
});
await sleep(1500);
await plan(['Write the to-do store', 'done'], ['Add done() to the store', 'now'], ['Note that ids start at 1', 'next'], ['Run the tests', 'next'], ['Update the README', 'next']);
await sleep(1200);
const edits = [
	{ oldText: '\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}', newText: '\tlist(): Todo[] {\n\t\treturn [...this.todos];\n\t}\n\n\tdone(id: number): Todo | undefined {\n\t\tconst todo = this.todos.find((t) => t.id === id);\n\t\tif (todo) todo.done = true;\n\t\treturn todo;\n\t}' },
	{ oldText: '// A to-do list kept in memory.', newText: '// A to-do list kept in memory. Ids start at 1.' },
];
await call('c2', 'edit', { path: a, edits }, () => {
	let text = readFileSync(a, 'utf-8');
	for (const e of edits) text = text.replace(e.oldText, e.newText);
	writeFileSync(a, text);
	return { firstChangedLine: 1 };
});
await plan(['Write the to-do store', 'done'], ['Add done() to the store', 'done'], ['Note that ids start at 1', 'done'], ['Run the tests', 'now'], ['Update the README', 'next']);
// Time for run.sh to open the plan drawer (ctrl+k v) and take a screenshot.
await sleep(Number(process.env.HOLD_MS ?? 0));
await fire('turn_end', {});
await fire('agent_end', {});
await sleep(300);
await fire('session_shutdown', {});
console.log('drive: done');
