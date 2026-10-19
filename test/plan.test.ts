import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSteps, planFromBranch, planSummary, prepareArguments } from '../pi/plan.ts';

test('steps are trimmed, empty ones dropped, an unknown state is next', () => {
	const steps = cleanSteps({ steps: [{ text: '  write   tests ', state: 'done' }, { text: ' ', state: 'now' }, { text: 'ship', state: 'later' }] });
	assert.deepEqual(steps, [
		{ text: 'write tests', state: 'done' },
		{ text: 'ship', state: 'next' },
	]);
});

test('only the first now stays now', () => {
	const steps = cleanSteps({ steps: [{ text: 'a', state: 'now' }, { text: 'b', state: 'now' }] });
	assert.deepEqual(steps.map((s) => s.state), ['now', 'next']);
});

test('long labels are cut and bad input gives no steps', () => {
	assert.equal(cleanSteps({ steps: [{ text: 'x'.repeat(200), state: 'next' }] })[0].text.length, 80);
	assert.deepEqual(cleanSteps(undefined), []);
	assert.deepEqual(cleanSteps({ steps: 'a, b' }), []);
});

test('the summary the model reads back is short', () => {
	assert.equal(planSummary([]), 'Plan cleared.');
	assert.equal(
		planSummary([
			{ text: 'a', state: 'done' },
			{ text: 'b', state: 'now' },
			{ text: 'c', state: 'next' },
		]),
		'Plan shown: 1 done, now: b, 1 next.',
	);
});

test('the last plan in the branch comes back after a reload', () => {
	const result = (toolName: string, steps: unknown) => ({ type: 'message', message: { role: 'toolResult', toolName, details: { steps } } });
	const branch = [
		result('plan', [{ text: 'old', state: 'now' }]),
		{ type: 'message', message: { role: 'user', content: 'hi' } },
		result('plan', [{ text: 'new', state: 'now' }]),
		result('todo', [{ text: 'not a plan', state: 'now' }]),
	];
	assert.deepEqual(planFromBranch(branch), [{ text: 'new', state: 'now' }]);
	assert.equal(planFromBranch([]), undefined);
});

test('arguments as models really send them become {steps}', () => {
	const want = [
		{ text: 'a', state: 'done' },
		{ text: 'b', state: 'now' },
		{ text: 'c', state: 'next' },
	];
	const prepared = (args: unknown) => prepareArguments(args).steps;
	// Seen in a session: the array as a JSON string, with other field names.
	assert.deepEqual(prepared({ steps: '[{"label": "a", "status": "done"}, {"label": "b", "status": "now"}, {"label": "c", "status": "next"}]' }), want);
	assert.deepEqual(prepared({ steps: '["[done] a", "[now] b", "[next] c"]' }), want);
	assert.deepEqual(prepared({ done: '["a"]', now: 'b', next: '["c"]' }), want);
	assert.deepEqual(prepared({ steps: want }), want);
	assert.deepEqual(prepared({ steps: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }, { text: 'c', status: 'pending' }] }), want);
	assert.deepEqual(prepared('not json'), []);
});

test('files: each step may name the files pi expects to change', () => {
	const at = (path: string) => (path.startsWith('/') ? path : `/w/${path}`);
	const steps = cleanSteps(
		{
			steps: [
				{ text: 'a', state: 'now', files: ['src/a.ts', ' src/a.ts ', '/abs/b.ts', '', 7, null] },
				{ text: 'b', state: 'next', files: '["c.ts"]' },
				{ text: 'c', state: 'next', files: 'not a list' },
				{ text: 'd', state: 'next', files: [] },
			],
		},
		at,
	);
	assert.deepEqual(steps[0].files, ['/w/src/a.ts', '/abs/b.ts']);
	assert.deepEqual(steps[1].files, ['/w/c.ts']);
	assert.equal('files' in steps[2], false, 'no list, no key');
	assert.equal('files' in steps[3], false);
});

test('files: at most 12 per step, and they survive the argument repair', () => {
	const many = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
	assert.equal(cleanSteps({ steps: [{ text: 'a', state: 'now', files: many }] })[0].files?.length, 12);
	const repaired = prepareArguments({ steps: '[{"label": "a", "status": "now", "files": ["x.ts"]}]' }).steps;
	assert.deepEqual(repaired, [{ text: 'a', state: 'now', files: ['x.ts'] }]);
});
