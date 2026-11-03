import { closeSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentSide } from '../core/agent/agent.ts';
import { applyTask, callOf, firstLine, stepsOf, type Task } from './map.ts';
import { TranscriptReader, type TranscriptEvent } from './transcript.ts';
import { ownDir, SESSION_ID, send, socketDir, socketPath } from './socket.mjs';

const MAX_MESSAGE = 64 * 1024 * 1024;
const MAX_READ = 8 * 1024 * 1024;
const MAX_STATUS = 64 * 1024;
const WAITING = new Set(['permission_prompt', 'elicitation_dialog', 'agent_needs_input']);
const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure']);

const id = process.argv[2] ?? '';
const pid = Number(process.env.CLAUDE_PID);
if (!SESSION_ID.test(id) || !Number.isInteger(pid) || pid <= 1 || !ownDir(socketDir())) process.exit(0);
const path = socketPath(id);
const statusFile = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'sessions', `${pid}.json`);

const side = new AgentSide({ id, agent: 'claude', can: [], cwd: process.cwd(), pid, host: { stop() {}, quit() {} } });
const { record } = side;
let tasks: Task[] = [];
let begun = false;
let ending = false;
let turnAt = 0;
let transcript: TranscriptReader | undefined;

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

function sizeOf(file: string): number {
	try {
		return statSync(file).size;
	} catch {
		return 0;
	}
}

function readFrom(file: string, offset: number): Buffer | undefined {
	try {
		const size = statSync(file).size;
		if (size <= offset) return undefined;
		const length = Math.min(size - offset, MAX_READ);
		const buffer = Buffer.alloc(length);
		const fd = openSync(file, 'r');
		try {
			readSync(fd, buffer, 0, length, offset);
		} finally {
			closeSync(fd);
		}
		return buffer;
	} catch {
		return undefined;
	}
}

function follow(file: string | undefined): void {
	if (!file || transcript?.path === file) return;
	transcript = new TranscriptReader(file, sizeOf(file));
}

function startTurn(): void {
	turnAt = Date.now();
	side.turnStart();
}

function idleSince(): number | undefined {
	try {
		if (statSync(statusFile).size > MAX_STATUS) return undefined;
		const status = JSON.parse(readFileSync(statusFile, 'utf-8'));
		if (status?.sessionId !== id || status.status !== 'idle' || typeof status.statusUpdatedAt !== 'number') return undefined;
		return status.statusUpdatedAt;
	} catch {
		return undefined;
	}
}

function checkIdle(): void {
	if (!record.working) return;
	const since = idleSince();
	if (since === undefined || since <= turnAt) return;
	record.waiting = null;
	side.turnEnd();
}

function settle(): void {
	if (record.waiting === null) return;
	record.waiting = null;
	side.beat();
}

function onTranscript(event: TranscriptEvent): void {
	if (event.kind === 'interrupted') {
		record.waiting = null;
		if (record.working) side.turnEnd();
		return;
	}
	settle();
	if (event.rejected) side.blocked(event.call);
}

function handle(event: unknown, input: Record<string, unknown>): void {
	if (typeof event !== 'string' || !EVENTS.has(event)) return;
	const cwd = text(input.cwd) ?? record.cwd;
	if (!begun) {
		side.begin(cwd);
		begun = true;
	}
	follow(text(input.transcript_path));
	const title = text(input.session_title);
	if (title) record.title = title;
	const call = text(input.tool_use_id);
	const target = callOf(input.tool_name, input.tool_input);
	if ((event === 'PreToolUse' || event === 'PostToolUse') && !record.working) startTurn();
	switch (event) {
		case 'SessionStart':
			record.model = text(input.model) ?? record.model;
			side.beat();
			return;
		case 'UserPromptSubmit':
			record.waiting = null;
			startTurn();
			return;
		case 'PreToolUse':
			if (target && call) side.ready(call, target.tool, target.args, cwd);
			return;
		case 'PostToolUse':
			settle();
			if (target && call) side.done(call, target.tool, target.args, cwd, true, firstLine(input.tool_response));
			else if (input.tool_name === 'TaskCreate' || input.tool_name === 'TaskUpdate') {
				tasks = applyTask(tasks, input.tool_name, input.tool_input, input.tool_response);
				record.plan = stepsOf(tasks);
				side.beat();
			}
			return;
		case 'PostToolUseFailure':
			settle();
			if (target && call) side.done(call, target.tool, target.args, cwd, false, 1);
			return;
		case 'Notification':
			if (typeof input.notification_type === 'string' && WAITING.has(input.notification_type)) {
				record.waiting = text(input.message) ?? 'a prompt';
				side.beat();
			} else if (input.notification_type === 'idle_prompt' && record.working && record.waiting === null) {
				side.turnEnd();
			}
			return;
		case 'Stop':
		case 'StopFailure':
			record.waiting = null;
			side.turnEnd();
			return;
		case 'SessionEnd':
			ending = true;
			return;
	}
}

function alive(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

function end(): void {
	clearInterval(timer);
	side.end();
	server.close();
	rmSync(path, { force: true });
	process.exit(0);
}

const server = createServer((socket) => {
	let buffer = Buffer.alloc(0);
	socket.on('error', () => undefined);
	socket.on('data', (data) => {
		buffer = Buffer.concat([buffer, data]);
		if (buffer.length > MAX_MESSAGE) return socket.destroy();
		const at = buffer.indexOf(0x0a);
		if (at < 0) return;
		let message: { event?: unknown; input?: unknown } | undefined;
		try {
			message = JSON.parse(buffer.subarray(0, at).toString('utf-8'));
		} catch {
			return socket.destroy();
		}
		const input = message?.input;
		if (input && typeof input === 'object' && !Array.isArray(input)) {
			try {
				handle(message?.event, input as Record<string, unknown>);
			} catch {
				// One bad message must not end the session's keeper.
			}
		}
		socket.end('ok\n', () => {
			if (ending) end();
		});
	});
});

server.on('error', async (error: NodeJS.ErrnoException) => {
	if (error.code !== 'EADDRINUSE') process.exit(0);
	if ((await send(path, { event: 'Ping', input: {} }, 500)) !== 'absent') process.exit(0);
	rmSync(path, { force: true });
	server.listen(path);
});
server.listen(path);

let ticks = 0;
const timer = setInterval(() => {
	side.poll();
	if (++ticks % 2 === 0 && transcript) for (const event of transcript.take(readFrom)) onTranscript(event);
	if (ticks % 10 === 0) {
		if (!alive(pid)) end();
		checkIdle();
	}
}, 100);

process.on('SIGTERM', end);
process.on('SIGINT', end);
