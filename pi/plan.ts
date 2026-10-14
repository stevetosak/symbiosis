// The plan: pi's own short list of steps, shown in the editor as a timeline
// (done › now › next). pi sends the whole list with each `plan` call. Pure, so
// the tests need no pi.
import type { Step, StepState } from '../core/protocol.ts';

/** Labels longer than this are cut: the timeline is one line. */
const MAX_TEXT = 80;
const MAX_STEPS = 30;

/** Plain JSON Schema: pi accepts it, and the extension needs no typebox. */
export const PLAN_PARAMETERS = {
	type: 'object',
	properties: {
		steps: {
			type: 'array',
			description: 'The whole plan, in order. Each call replaces the plan.',
			items: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'A short label, at most 8 words.' },
					state: { type: 'string', enum: ['done', 'now', 'next'] },
				},
				required: ['text', 'state'],
			},
		},
	},
	required: ['steps'],
} as const;

export const PLAN_DESCRIPTION =
	'Show your plan to the user in their editor as a timeline: done › now › next. Send the whole list each time, as a JSON array (not a string): {"steps": [{"text": "Write the tests", "state": "now"}]}. state is done, now or next.';
export const PLAN_SNIPPET = "Show your plan (done, now, next steps) in the user's editor";
export const PLAN_GUIDELINES = [
	'For a task with two or more steps, call plan when you start and each time a step is done. Labels are short (at most 8 words). While you work, exactly one step is now.',
];

/** A JSON string becomes its value; anything else stays as it is. */
function unstring(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const t = value.trim();
	if (!t.startsWith('[') && !t.startsWith('{')) return value;
	try {
		return JSON.parse(t);
	} catch {
		return value;
	}
}

const STATES: Record<string, StepState> = { done: 'done', now: 'now', next: 'next', completed: 'done', in_progress: 'now', current: 'now', pending: 'next', todo: 'next' };

/** One step from what a model sends: `{text, state}`, `{label, status}`, or "[done] text". */
function toStep(item: unknown, state?: StepState): { text: unknown; state: unknown } {
	const value = unstring(item);
	if (typeof value === 'string') {
		const m = value.match(/^\s*\[?(done|now|next|completed|in_progress|current|pending|todo)\]?\s*[:\-]?\s+(.*)$/i);
		if (m) return { text: m[2], state: state ?? STATES[m[1].toLowerCase()] };
		return { text: value, state: state ?? 'next' };
	}
	const o = (value ?? {}) as Record<string, unknown>;
	const raw = o.state ?? o.status;
	return {
		text: o.text ?? o.label ?? o.title ?? o.step ?? o.content,
		state: state ?? (typeof raw === 'string' ? (STATES[raw.toLowerCase()] ?? raw) : raw),
	};
}

/**
 * Runs before pi validates the arguments. A model that meets this tool in the
 * middle of a conversation (added by /reload) has sent the array as a JSON
 * string, and has guessed other field names ({done, now, next}, {label,
 * status}, "[done] text"). All of these become `{steps}`.
 */
export function prepareArguments(args: unknown): { steps: Step[] } {
	const a = (unstring(args) ?? {}) as Record<string, unknown>;
	const steps = unstring(a.steps);
	if (Array.isArray(steps)) return { steps: cleanSteps({ steps: steps.map((s) => toStep(s)) }) };
	const out: { text: unknown; state: unknown }[] = [];
	for (const state of ['done', 'now', 'next'] as const) {
		const v = unstring(a[state]);
		for (const item of Array.isArray(v) ? v : v === undefined ? [] : [v]) out.push(toStep(item, state));
	}
	// Clean here: pi validates what this returns, so it must match the schema.
	return { steps: cleanSteps({ steps: out }) };
}

/** The steps as given, made safe: trimmed, cut, at most one `now` (later ones become `next`). */
export function cleanSteps(input: unknown): Step[] {
	const raw = (input as { steps?: unknown })?.steps;
	if (!Array.isArray(raw)) return [];
	const steps: Step[] = [];
	let now = false;
	for (const item of raw.slice(0, MAX_STEPS)) {
		const text = typeof item?.text === 'string' ? item.text.replace(/\s+/g, ' ').trim() : '';
		if (text === '') continue;
		let state: StepState = item.state === 'done' || item.state === 'now' ? item.state : 'next';
		if (state === 'now') {
			if (now) state = 'next';
			now = true;
		}
		steps.push({ text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text, state });
	}
	return steps;
}

/** The tool result the model reads back: short, so it costs few tokens. */
export function planSummary(steps: Step[]): string {
	if (steps.length === 0) return 'Plan cleared.';
	const done = steps.filter((s) => s.state === 'done').length;
	const now = steps.find((s) => s.state === 'now');
	const next = steps.filter((s) => s.state === 'next').length;
	return `Plan shown: ${done} done${now ? `, now: ${now.text}` : ''}, ${next} next.`;
}

/** The last plan in a session branch, so the timeline comes back after /reload. */
export function planFromBranch(entries: Iterable<unknown>): Step[] | undefined {
	let plan: Step[] | undefined;
	for (const entry of entries) {
		const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
		if (e.type !== 'message' || e.message?.role !== 'toolResult' || e.message.toolName !== 'plan') continue;
		const details = e.message.details as { steps?: unknown } | undefined;
		if (Array.isArray(details?.steps)) plan = cleanSteps(details);
	}
	return plan;
}
