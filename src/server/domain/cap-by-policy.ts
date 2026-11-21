import type { Action } from '../../shared/permissions';
import { evaluatePolicy, type PolicyGroup } from './policy';

export interface PolicyCapTarget {
	orgId?: string;
	departmentId?: string;
	siteId?: string;
	policy: readonly PolicyGroup[];
}

// the policy layer of authorize: takes the actions the grants allow, returns the ones the policy
// stack lets through; a step-up rule is not a cap, so it is treated as met here
export function capByPolicy(
	actions: ReadonlySet<Action>,
	target: PolicyCapTarget
): ReadonlySet<Action> {
	if (target.policy.length === 0) return actions;
	const kept = new Set<Action>();
	for (const action of actions) {
		if (evaluatePolicy(target.policy, action, { stepUp: true }) === null) kept.add(action);
	}
	return kept;
}
