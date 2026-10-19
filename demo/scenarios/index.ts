// Every scenario, in the order `--list` shows them. `flow` is the default.
import { changes } from './changes.ts';
import { flow } from './flow.ts';
import { follow } from './follow.ts';
import { helpi } from './helpi.ts';
import type { Scenario } from './kit.ts';
import { diff, marks, seen } from './marks.ts';
import { planScenario } from './plan.ts';

export const SCENARIOS: Scenario[] = [flow, follow, planScenario, changes, marks, seen, diff, helpi];
export const DEFAULT = 'flow';

export const find = (name: string): Scenario | undefined => SCENARIOS.find((s) => s.name === name);

/** The `--list` text. */
export function listing(): string {
	const width = Math.max(...SCENARIOS.map((s) => s.name.length));
	return SCENARIOS.map((s) => `  ${s.name.padEnd(width)}  ${s.title}${s.name === DEFAULT ? '  (default)' : ''}`).join('\n');
}
