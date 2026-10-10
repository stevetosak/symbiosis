// The plan: pi's own short list of steps, shown in the editor as a timeline
// (done › now › next). pi sends the whole list with each `plan` call. Pure, so
// the tests need no pi.

export type StepState = 'done' | 'now' | 'next';

export interface Step {
	text: string;
	state: StepState;
}

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
	'Show your plan to the user in their editor as a timeline: done › now › next. Send the whole list each time.';
export const PLAN_SNIPPET = "plan: show your plan (done, now, next steps) in the user's editor";
export const PLAN_GUIDELINES = [
	'For a task with two or more steps, call plan when you start and each time a step is done. Labels are short (at most 8 words). While you work, exactly one step is now.',
];

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
