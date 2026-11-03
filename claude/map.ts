import type { Step, StepState, Tool } from '../core/protocol.ts';

export const MAX_TASKS = 100;
const MAX_SUBJECT = 200;

export interface Call {
	tool: Tool;
	args: Record<string, unknown>;
}

export interface Task {
	id: string;
	subject: string;
	status: 'pending' | 'in_progress' | 'completed';
}

const STATUSES: readonly Task['status'][] = ['pending', 'in_progress', 'completed'];
const STATE: Record<Task['status'], StepState> = { completed: 'done', in_progress: 'now', pending: 'next' };

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value !== '' ? value : undefined;
}

export function callOf(toolName: unknown, toolInput: unknown): Call | undefined {
	const input = record(toolInput);
	const path = text(input?.file_path);
	if (!input || !path) return undefined;
	if (toolName === 'Write') {
		return typeof input.content === 'string' ? { tool: 'write', args: { path, content: input.content } } : undefined;
	}
	if (toolName === 'Edit') {
		if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return undefined;
		return { tool: 'edit', args: { path, edits: [{ oldText: input.old_string, newText: input.new_string }] } };
	}
	return undefined;
}

export function firstLine(toolResponse: unknown): number {
	const patch = record(toolResponse)?.structuredPatch;
	const hunk = Array.isArray(patch) ? record(patch[0]) : undefined;
	if (!hunk || typeof hunk.newStart !== 'number' || !Array.isArray(hunk.lines)) return 1;
	const at = hunk.lines.findIndex((line) => typeof line === 'string' && (line.startsWith('+') || line.startsWith('-')));
	return Math.max(1, hunk.newStart + Math.max(0, at));
}

export function applyTask(tasks: Task[], toolName: unknown, toolInput: unknown, toolResponse: unknown): Task[] {
	const input = record(toolInput);
	if (toolName === 'TaskCreate') {
		const id = text(record(record(toolResponse)?.task)?.id);
		const subject = text(input?.subject);
		if (!id || !subject) return tasks;
		const task: Task = { id, subject: subject.slice(0, MAX_SUBJECT), status: 'pending' };
		return [...tasks.filter((t) => t.id !== id), task].slice(-MAX_TASKS);
	}
	if (toolName === 'TaskUpdate') {
		const id = text(input?.taskId);
		if (!id) return tasks;
		if (input?.status === 'deleted') return tasks.filter((t) => t.id !== id);
		const status = STATUSES.find((s) => s === input?.status);
		const subject = text(input?.subject)?.slice(0, MAX_SUBJECT);
		return tasks.map((t) => (t.id === id ? { ...t, ...(status ? { status } : {}), ...(subject ? { subject } : {}) } : t));
	}
	return tasks;
}

export function stepsOf(tasks: Task[]): Step[] {
	return tasks.map((t) => ({ text: t.subject, state: STATE[t.status] }));
}
