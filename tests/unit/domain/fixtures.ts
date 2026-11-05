import {
	authorize,
	type AuthorizeInput,
	type Facts,
	type Principal,
	type Resource
} from '../../../src/server/domain/authorize';
import type { Action, OrgRole } from '../../../src/shared/permissions';

export const ORG = 'org-1';
export const OTHER_ORG = 'org-2';
export const AGENCY = 'agency-1';
export const DEPT = 'dept-1';
export const SITE = 'site-1';
export const NOW = 1_000_000;

export const user: Principal = { kind: 'user', userId: 'user-1' };
export const keyPrincipal: Principal = { kind: 'key', keyId: 'key-1', issuerId: 'user-1' };
export const resource: Resource = { orgId: ORG, departmentId: DEPT, siteId: SITE };

export const FEATURES = ['sso', 'agency', 'pilots', 'environments', 'previews'];

export function facts(over: Partial<Facts> = {}): Facts {
	return {
		now: NOW,
		flags: {},
		grants: [],
		agencyMemberships: [],
		delegations: [],
		policy: [],
		entitlements: FEATURES,
		budgetExceeded: [],
		...over
	};
}

export const member = (role: OrgRole): Partial<Facts> => ({ membership: { orgId: ORG, role } });
export const fresh: Partial<Facts> = { stepUpAt: NOW - 1000 };
export const admin: Partial<Facts> = {
	platform: {
		admin: true,
		access: true,
		permissions: ['read', 'support', 'billing_support', 'infrastructure']
	}
};

export function check(action: string, f: Facts, over: Partial<AuthorizeInput> = {}): string {
	const d = authorize({ principal: user, action, resource, facts: f, ...over });
	return d.allow ? 'allow' : d.reason;
}

export function allowedSet(
	actions: readonly Action[],
	f: Facts,
	over: Partial<AuthorizeInput> = {}
) {
	return actions.filter((a) => check(a, f, over) === 'allow');
}
