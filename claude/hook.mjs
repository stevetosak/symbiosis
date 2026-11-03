import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ownDir, pluginDir, SESSION_ID, send, socketDir, socketPath } from './socket.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const START_TRIES = 40;
const START_WAIT_MS = 50;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readInput() {
	try {
		const input = JSON.parse(readFileSync(0, 'utf-8'));
		return input && typeof input === 'object' && !Array.isArray(input) ? input : undefined;
	} catch {
		return undefined;
	}
}

function startKeeper(id, cwd) {
	const child = spawn(join(here, '..', 'bin', 'run-node'), [join(here, 'keeper.ts'), id], {
		detached: true,
		stdio: 'ignore',
		cwd: typeof cwd === 'string' && existsSync(cwd) ? cwd : undefined,
		env: process.env,
	});
	child.on('error', () => undefined);
	child.unref();
}

async function main() {
	const input = readInput();
	if (!input || typeof input.session_id !== 'string' || !SESSION_ID.test(input.session_id)) return;
	if (!existsSync(pluginDir()) || !ownDir(socketDir())) return;
	const path = socketPath(input.session_id);
	const message = { event: input.hook_event_name, input };
	if ((await send(path, message)) !== 'absent' || input.hook_event_name === 'SessionEnd') return;
	startKeeper(input.session_id, input.cwd);
	for (let i = 0; i < START_TRIES; i++) {
		await sleep(START_WAIT_MS);
		if ((await send(path, message)) !== 'absent') return;
	}
}

main()
	.catch(() => undefined)
	.finally(() => process.exit(0));
