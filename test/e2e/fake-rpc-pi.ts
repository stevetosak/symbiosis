// A fake `pi --mode rpc` for test/e2e/app.sh: no model, no tokens. It speaks
// the JSONL protocol on stdin and stdout and writes what it got to $FAKE_LOG.
//
// The prompt "ask" makes it ask three dialogs in a row (confirm, select,
// input), as a guard or a question tool would, then notify "all answered".
// Closing stdin ends it, as it ends the real pi.
import { appendFileSync } from 'node:fs';

const logPath = process.env.FAKE_LOG ?? '/dev/null';
const log = (line: string) => appendFileSync(logPath, `${line}\n`);
const out = (record: object) => process.stdout.write(`${JSON.stringify(record)}\n`);

log(`argv: ${process.argv.slice(2).join(' ')}`);
log(`cwd: ${process.cwd()}`);

const dialogs = [
	{ type: 'extension_ui_request', id: 'c1', method: 'confirm', title: 'Allow this one call?', message: 'rm -rf build' },
	{ type: 'extension_ui_request', id: 's1', method: 'select', title: 'Which way?', options: ['Allow', 'Block'] },
	{ type: 'extension_ui_request', id: 'i1', method: 'input', title: 'Your name' },
];
let asking = -1;

function handle(record: Record<string, unknown>): void {
	if (record.type === 'get_state') {
		out({ id: record.id, type: 'response', command: 'get_state', success: true, data: { isStreaming: false, messageCount: 0 } });
	} else if (record.type === 'prompt') {
		log(`prompt: ${String(record.message)}${record.streamingBehavior ? ` (${String(record.streamingBehavior)})` : ''}`);
		out({ id: record.id, type: 'response', command: 'prompt', success: true, data: { disposition: 'started' } });
		out({ type: 'agent_start' });
		if (record.message === 'ask') {
			asking = 0;
			out(dialogs[0]);
		} else {
			out({ type: 'agent_end' });
			out({ type: 'agent_settled' });
		}
	} else if (record.type === 'extension_ui_response') {
		const { type: _type, id, ...rest } = record;
		log(`answer ${String(id)}: ${JSON.stringify(rest)}`);
		asking++;
		if (asking < dialogs.length) {
			out(dialogs[asking]);
		} else {
			out({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'all answered', notifyType: 'info' });
			out({ type: 'agent_end' });
			out({ type: 'agent_settled' });
		}
	}
}

let rest = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
	const parts = (rest + chunk).split('\n');
	rest = parts.pop() ?? '';
	for (const line of parts) if (line.trim()) handle(JSON.parse(line));
});
process.stdin.on('end', () => {
	log('stdin closed');
	process.exit(0);
});
