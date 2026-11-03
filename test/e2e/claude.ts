// A fake Claude Code for test/e2e/claude.sh: it plays two turns through the
// real hooks (claude/hook.mjs), so the keeper writes what ttt reads. The
// second turn waits on a permission prompt until ttt stops it. Needs
// TTT_CONFIG_DIR, SYMBIOSIS_RUN_DIR, and a fake herdr in PATH.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [ws, transcript, out] = process.argv.slice(2);
const session = 'e2e-claude';
const repo = join(import.meta.dirname, '..', '..');
const plugin = join(process.env.TTT_CONFIG_DIR ?? '', 'plugins', 'symbiosis');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let seq = 0;

function hook(event: string, fields: Record<string, unknown> = {}): void {
	const input = { session_id: session, transcript_path: transcript, cwd: ws, hook_event_name: event, ...fields };
	spawnSync(process.execPath, [join(repo, 'claude', 'hook.mjs')], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PID: String(process.pid) } });
	console.log(event + (fields.tool_name ? ` ${fields.tool_name}` : ''));
}

function owner(): boolean {
	const file = join(plugin, 'ttt.json');
	return existsSync(file) && JSON.parse(readFileSync(file, 'utf-8')).owner === session;
}

function task(subject: string): void {
	seq++;
	hook('PostToolUse', { tool_name: 'TaskCreate', tool_use_id: `task${seq}`, tool_input: { subject }, tool_response: { task: { id: String(seq), subject } } });
}

function status(taskId: string, value: string): void {
	hook('PostToolUse', { tool_name: 'TaskUpdate', tool_use_id: `upd${taskId}${value}`, tool_input: { taskId, status: value }, tool_response: { success: true } });
}

function call(id: string, tool: 'Write' | 'Edit', input: Record<string, unknown>, after: string, response: Record<string, unknown>): void {
	hook('PreToolUse', { tool_name: tool, tool_use_id: id, tool_input: input });
	writeFileSync(input.file_path as string, after);
	hook('PostToolUse', { tool_name: tool, tool_use_id: id, tool_input: input, tool_response: response });
}

const store = join(ws, 'store.ts');
const first = 'export const items: string[] = [];\n\nexport function add(text: string): void {\n\titems.push(text);\n}\n';
const second = `${first}\nexport function done(i: number): void {\n\titems.splice(i, 1);\n}\n`;

hook('SessionStart', { source: 'startup', model: 'claude-haiku-5-5' });
for (let i = 0; i < 80 && !owner(); i++) await sleep(50);
console.log(`owner: ${owner() ? 'this' : 'none'}`);
hook('UserPromptSubmit', { prompt: 'a store with add and done' });
task('Write the store');
task('Add done(i)');
status('1', 'in_progress');
call('w1', 'Write', { file_path: store, content: first }, first, { type: 'create', structuredPatch: [] });
status('1', 'completed');
status('2', 'in_progress');
call('e1', 'Edit', { file_path: store, old_string: '\titems.push(text);\n}\n', new_string: '\titems.push(text);\n}\n\nexport function done(i: number): void {\n\titems.splice(i, 1);\n}\n' }, second, {
	structuredPatch: [{ oldStart: 4, oldLines: 2, newStart: 4, newLines: 6, lines: [' \titems.push(text);', ' }', '+', '+export function done(i: number): void {', '+\titems.splice(i, 1);', '+}'] }],
});
console.log('written');
await sleep(5000);
status('2', 'completed');
hook('Stop', { stop_hook_active: false });

async function until(file: string, ms: number): Promise<boolean> {
	for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (existsSync(file)) return true;
	return false;
}

await until(join(out, 'idle.txt'), 15000);
hook('UserPromptSubmit', { prompt: 'and a test' });
hook('PreToolUse', { tool_name: 'Write', tool_use_id: 'w2', tool_input: { file_path: join(ws, 'store.test.ts'), content: 'test\n' } });
hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Write' });
console.log(`stopped: ${(await until(join(out, 'esc.txt'), 15000)) ? 'yes' : 'no'}`);
await sleep(2500);
hook('SessionEnd', { reason: 'other' });
