import {
	ORG_ROLE_ACTIONS,
	SITE_ROLE_ACTIONS,
	actionDef,
	isOrgRole,
	type Action,
	type OrgRole
} from '../../shared/permissions';

export const DELEGATION_ROLES = ['maintainer', 'viewer'] as const;
export type DelegationRole = (typeof DELEGATION_ROLES)[number];

export type DelegationStatus = 'pending' | 'active' | 'revoked';

export interface Delegation {
	id: string;
	clientOrgId: string;
	agencyOrgId: string;
	role: DelegationRole;
	sites: 'all' | readonly string[];
	status: DelegationStatus;
	createdBy: string;
	createdAt: number;
	acceptedAt?: number;
	expiresAt?: number;
	revokedAt?: number;
	revokedByOrgId?: string;
}

export type DelegationError =
	| 'same_org'
	| 'bad_role'
	| 'bad_expiry'
	| 'no_sites'
	| 'not_pending'
	| 'expired'
	| 'not_party'
	| 'wrong_side'
	| 'already_revoked';

export type DelegationResult =
	{ ok: true; delegation: Delegation } | { ok: false; reason: DelegationError };

const fail = (reason: DelegationError): DelegationResult => ({ ok: false, reason });

export function createDelegation(input: {
	id: string;
	clientOrgId: string;
	agencyOrgId: string;
	role: string;
	sites: 'all' | readonly string[];
	createdBy: string;
	now: number;
	expiresAt?: number;
}): DelegationResult {
	if (input.clientOrgId === input.agencyOrgId) return fail('same_org');
	if (!(DELEGATION_ROLES as readonly string[]).includes(input.role)) return fail('bad_role');
	if (input.expiresAt !== undefined && input.expiresAt <= input.now) return fail('bad_expiry');
	if (input.sites !== 'all' && input.sites.length === 0) return fail('no_sites');
	return {
		ok: true,
		delegation: {
			id: input.id,
			clientOrgId: input.clientOrgId,
			agencyOrgId: input.agencyOrgId,
			role: input.role as DelegationRole,
			sites: input.sites,
			status: 'pending',
			createdBy: input.createdBy,
			createdAt: input.now,
			expiresAt: input.expiresAt
		}
	};
}

// the caller checks the actor holds delegation.accept in the agency; this checks the side
export function acceptDelegation(
	d: Delegation,
	input: { orgId: string; now: number }
): DelegationResult {
	if (d.status === 'revoked') return fail('already_revoked');
	if (d.status !== 'pending') return fail('not_pending');
	if (input.orgId !== d.agencyOrgId) {
		return fail(input.orgId === d.clientOrgId ? 'wrong_side' : 'not_party');
	}
	if (d.expiresAt !== undefined && d.expiresAt <= input.now) return fail('expired');
	return { ok: true, delegation: { ...d, status: 'active', acceptedAt: input.now } };
}

export function revokeDelegation(
	d: Delegation,
	input: { orgId: string; now: number }
): DelegationResult {
	if (input.orgId !== d.clientOrgId && input.orgId !== d.agencyOrgId) return fail('not_party');
	if (d.status === 'revoked') return fail('already_revoked');
	return {
		ok: true,
		delegation: { ...d, status: 'revoked', revokedAt: input.now, revokedByOrgId: input.orgId }
	};
}

export function isActive(d: Delegation, now: number): boolean {
	return d.status === 'active' && (d.expiresAt === undefined || now < d.expiresAt);
}

export function coversSite(d: Delegation, siteId: string | undefined): boolean {
	if (siteId === undefined) return false;
	return d.sites === 'all' || d.sites.includes(siteId);
}

// the minimum of two roles is the intersection of their site actions
export function delegatedActions(
	delegationRole: DelegationRole,
	memberRole: OrgRole
): ReadonlySet<Action> {
	if (
		!isOrgRole(memberRole) ||
		!(DELEGATION_ROLES as readonly string[]).includes(delegationRole)
	) {
		return new Set();
	}
	const member = new Set(
		ORG_ROLE_ACTIONS[memberRole].filter((a) => actionDef(a).scope === 'site')
	);
	return new Set(SITE_ROLE_ACTIONS[delegationRole].filter((a) => member.has(a)));
}

// every action through a delegation writes an audit row in both organisations
export function delegationAudit(d: Delegation): readonly [string, string] {
	return [d.clientOrgId, d.agencyOrgId];
}
