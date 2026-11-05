import {
	ORG_ROLE_ACTIONS,
	SITE_ROLE_ACTIONS,
	actionDef,
	isOrgRole,
	isSiteRole,
	type Action,
	type ActionScope,
	type OrgRole,
	type SiteRole
} from '../../shared/permissions';

export const CLASSIFICATIONS = ['public', 'internal', 'restricted', 'regulated'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export type GrantLevel = 'organisation' | 'department' | 'site';

export type Grant =
	| { level: 'department'; orgId: string; targetId: string; role: OrgRole }
	| { level: 'site'; orgId: string; targetId: string; role: SiteRole };

export interface PolicyRule {
	id: string;
	deny?: readonly string[];
	stepUp?: readonly string[];
}

export interface PolicyGroup {
	id: string;
	name: string;
	rules: readonly PolicyRule[];
}

export interface PolicyBlock {
	reason: 'policy_denied' | 'step_up_required';
	policy: string;
	rule: string;
}

export class PolicyGroupMissingError extends Error {
	constructor(readonly missing: readonly string[]) {
		super(`policy groups not found: ${missing.join(', ')}`);
		this.name = 'PolicyGroupMissingError';
	}
}

const LEVEL_RANK: Record<GrantLevel, number> = { organisation: 0, department: 1, site: 2 };
const SCOPE_RANK: Record<Exclude<ActionScope, 'account' | 'admin'>, number> = {
	org: 0,
	department: 1,
	site: 2
};

// a grant at one level gives actions addressed at that level or below, never above
export function grantReaches(level: GrantLevel, action: Action): boolean {
	const scope = actionDef(action).scope;
	if (scope === 'account' || scope === 'admin') return false;
	return SCOPE_RANK[scope] >= LEVEL_RANK[level];
}

export type AnyGrant = Grant | { level: 'organisation'; role: OrgRole };

export function grantProvides(grant: AnyGrant, action: Action): boolean {
	if (!grantReaches(grant.level, action)) return false;
	if (grant.level === 'site') {
		return isSiteRole(grant.role) && SITE_ROLE_ACTIONS[grant.role].includes(action);
	}
	return isOrgRole(grant.role) && ORG_ROLE_ACTIONS[grant.role].includes(action);
}

export function matchesPattern(pattern: string, action: string): boolean {
	if (pattern === '*') return true;
	if (pattern.endsWith('.*')) return action.startsWith(pattern.slice(0, -1));
	return pattern === action;
}

export function evaluatePolicy(
	groups: readonly PolicyGroup[],
	action: Action,
	opts: { stepUp: boolean }
): PolicyBlock | null {
	for (const group of groups) {
		for (const rule of group.rules) {
			if (rule.deny?.some((p) => matchesPattern(p, action))) {
				return { reason: 'policy_denied', policy: group.id, rule: rule.id };
			}
		}
	}
	if (!opts.stepUp) {
		for (const group of groups) {
			for (const rule of group.rules) {
				if (rule.stepUp?.some((p) => matchesPattern(p, action))) {
					return { reason: 'step_up_required', policy: group.id, rule: rule.id };
				}
			}
		}
	}
	return null;
}

export function defaultPolicyGroupId(
	label: Classification,
	mapping?: Partial<Record<Classification, string>>
): string {
	return mapping?.[label] ?? `classification:${label}`;
}

export interface PolicyAssignments {
	organisation: readonly string[];
	department: readonly string[];
	site: readonly string[];
	classification?: Classification;
	classificationMapping?: Partial<Record<Classification, string>>;
}

// every assigned group applies and caps only tighten, so the stack is the most restrictive
export function resolvePolicyGroups(
	assignments: PolicyAssignments,
	groups: ReadonlyMap<string, PolicyGroup>
): PolicyGroup[] {
	const ids = [...assignments.organisation, ...assignments.department, ...assignments.site];
	if (assignments.classification) {
		ids.push(
			defaultPolicyGroupId(assignments.classification, assignments.classificationMapping)
		);
	}
	const unique = [...new Set(ids)];
	const missing = unique.filter((id) => !groups.has(id));
	if (missing.length > 0) throw new PolicyGroupMissingError(missing);
	return unique.map((id) => groups.get(id) as PolicyGroup);
}
