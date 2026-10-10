import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSteps, planFromBranch, planSummary } from '../pi/plan.ts';

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
