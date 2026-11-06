import {
	ACTIONS,
	BREAK_GLASS_ROLE,
	ORG_ROLE_ACTIONS,
	STEP_UP_WINDOW_MS,
	SUSPENDED_ORG_ACTIONS,
	actionDef,
	isAction,
	isOrgRole,
	type Action,
	type ActionDef,
	type BudgetKey,
	type OrgRole,
	type PlatformPermission,
	type SupportRole
} from '../../shared/permissions';
import {
	coversSite,
	delegatedActions,
	delegationAudit,
	isActive,
	type Delegation
} from './delegation';
import { evaluatePolicy, grantProvides, type Grant, type PolicyGroup } from './policy';
import { keyAllows, type ApiKeyFacts } from './scopes';

export type Principal =
	{ kind: 'user'; userId: string } | { kind: 'key'; keyId: string; issuerId: string };

export interface Resource {
	orgId?: string;
	departmentId?: string;
	siteId?: string;
}

export interface Membership {
	orgId: string;
	role: OrgRole;
}

export interface SupportGrant {
	orgId: string;
	role: SupportRole;
	expiresAt: number;
	siteIds?: readonly string[];
}

export interface BreakGlass {
	orgId: string;
	reason: string;
}

// every field comes from a server-side lookup. For a key, the subject fields describe the issuer.
export interface Facts {
	now: number;
	stepUpAt?: number;
	flags: { userSuspended?: boolean; suspendedOrgIds?: readonly string[] };
	platform?: { admin: boolean; access: boolean; permissions: readonly PlatformPermission[] };
	membership?: Membership;
	grants: readonly Grant[];
	agencyMemberships: readonly Membership[];
	delegations: readonly Delegation[];
	supportGrant?: SupportGrant;
	breakGlass?: BreakGlass;
	key?: ApiKeyFacts;
	policy: readonly PolicyGroup[];
	entitlements: readonly string[];
	budgetExceeded: readonly BudgetKey[];
}

export type Via =
	| 'self'
	| 'platform'
	| 'organisation'
	| 'department'
	| 'site'
	| 'delegation'
	| 'support-grant'
	| 'break-glass';

export type DenyReason =
	| 'unknown_action'
	| 'user_suspended'
	| 'org_suspended'
	| 'platform_denied'
	| 'bad_resource'
	| 'not_a_member'
	| 'forbidden'
	| 'support_grant_expired'
	| 'break_glass_invalid'
	| 'session_only'
	| 'key_revoked'
	| 'key_expired'
	| 'key_scope'
	| 'policy_denied'
	| 'step_up_required'
	| 'entitlement_required'
	| 'budget_exceeded';

export interface DenyDetail {
	policy?: string;
	rule?: string;
	feature?: string;
	budget?: string;
}

export type Decision =
	| { allow: true; via: Via; audit: readonly string[]; notifyOwners?: string }
	| { allow: false; reason: DenyReason; detail?: DenyDetail };

export interface AuthorizeInput {
	principal: Principal;
	action: string;
	resource?: Resource;
	facts: Facts;
}

const deny = (reason: DenyReason, detail?: DenyDetail): Decision => ({
	allow: false,
	reason,
	...(detail ? { detail } : {})
});

export function stepUpFresh(principal: Principal, facts: Facts): boolean {
	if (principal.kind !== 'user' || facts.stepUpAt === undefined) return false;
	const age = facts.now - facts.stepUpAt;
	return age >= 0 && age <= STEP_UP_WINDOW_MS;
}

function platformReady(facts: Facts, permission: PlatformPermission): boolean {
	const p = facts.platform;
	return p?.admin === true && p.access === true && p.permissions.includes(permission);
}

function roleActions(role: unknown): readonly Action[] {
	return isOrgRole(role) ? ORG_ROLE_ACTIONS[role] : [];
}

type Source =
	{ via: Via; audit: readonly string[]; notifyOwners?: string } | { blocked: DenyReason };

function findSource(
	principal: Principal,
	action: Action,
	def: ActionDef,
	resource: Resource,
	facts: Facts
): Source | undefined {
	const orgId = resource.orgId as string;
	const own: readonly string[] = [orgId];
	const { membership } = facts;

	if (membership?.orgId === orgId && roleActions(membership.role).includes(action)) {
		return { via: 'organisation', audit: own };
	}

	for (const grant of facts.grants) {
		if (grant.orgId !== orgId) continue;
		if (grant.level === 'department') {
			if (resource.departmentId === undefined || grant.targetId !== resource.departmentId)
				continue;
			if (grantProvides(grant, action)) return { via: 'department', audit: own };
		} else if (grant.level === 'site') {
			if (resource.siteId === undefined || grant.targetId !== resource.siteId) continue;
			if (grantProvides(grant, action)) return { via: 'site', audit: own };
		}
	}

	let blocked: DenyReason | undefined;

	const sg = facts.supportGrant;
	if (sg && sg.orgId === orgId && platformReady(facts, 'support')) {
		if (sg.expiresAt <= facts.now) {
			blocked = 'support_grant_expired';
		} else {
			const siteOk =
				sg.siteIds === undefined ||
				(def.scope === 'site' &&
					resource.siteId !== undefined &&
					sg.siteIds.includes(resource.siteId));
			if (siteOk && !def.content && roleActions(sg.role).includes(action)) {
				return { via: 'support-grant', audit: own };
			}
		}
	}

	const bg = facts.breakGlass;
	if (bg && bg.orgId === orgId && platformReady(facts, 'support')) {
		if (bg.reason.trim().length === 0) {
			blocked ??= 'break_glass_invalid';
		} else if (!stepUpFresh(principal, facts)) {
			blocked ??= 'step_up_required';
		} else if (!def.content && roleActions(BREAK_GLASS_ROLE).includes(action)) {
			return { via: 'break-glass', audit: own, notifyOwners: orgId };
		}
	}

	if (def.scope === 'site') {
		for (const d of facts.delegations) {
			if (
				d.clientOrgId !== orgId ||
				!isActive(d, facts.now) ||
				!coversSite(d, resource.siteId)
			) {
				continue;
			}
			const agency = facts.agencyMemberships.find((m) => m.orgId === d.agencyOrgId);
			if (agency && delegatedActions(d.role, agency.role).has(action)) {
				// authorize checks the client org's suspension; this is the acting agency's own
				if (facts.flags.suspendedOrgIds?.includes(d.agencyOrgId)) {
					blocked ??= 'org_suspended';
					continue;
				}
				return { via: 'delegation', audit: delegationAudit(d) };
			}
		}
	}

	if (blocked) return { blocked };
	return undefined;
}

function hasRelation(resource: Resource, facts: Facts): boolean {
	const orgId = resource.orgId;
	const acting =
		platformReady(facts, 'support') &&
		(facts.supportGrant?.orgId === orgId || facts.breakGlass?.orgId === orgId);
	return (
		acting ||
		facts.membership?.orgId === orgId ||
		facts.grants.some((g) => g.orgId === orgId) ||
		facts.delegations.some(
			(d) =>
				d.clientOrgId === orgId &&
				facts.agencyMemberships.some((m) => m.orgId === d.agencyOrgId)
		)
	);
}

export function authorize(input: AuthorizeInput): Decision {
	const { principal, facts } = input;
	if (!isAction(input.action)) return deny('unknown_action');
	const action: Action = input.action;
	const def = actionDef(action);
	const resource = input.resource ?? {};

	// platform flags
	if (facts.flags.userSuspended) return deny('user_suspended');
	if (
		resource.orgId !== undefined &&
		facts.flags.suspendedOrgIds?.includes(resource.orgId) &&
		!SUSPENDED_ORG_ACTIONS.includes(action)
	) {
		return deny('org_suspended');
	}

	let via: Via;
	let audit: readonly string[] = resource.orgId === undefined ? [] : [resource.orgId];
	let notifyOwners: string | undefined;

	if (def.scope === 'admin') {
		if (principal.kind === 'key') return deny('session_only');
		if (!platformReady(facts, def.platform as PlatformPermission))
			return deny('platform_denied');
		via = 'platform';
	} else if (def.scope === 'account') {
		via = 'self';
	} else {
		if (resource.orgId === undefined) return deny('bad_resource');
		if (def.scope === 'site' && resource.siteId === undefined) return deny('bad_resource');

		// membership, grants (organisation, department, site), then delegation
		const source = findSource(principal, action, def, resource, facts);
		if (source === undefined)
			return deny(hasRelation(resource, facts) ? 'forbidden' : 'not_a_member');
		if ('blocked' in source) return deny(source.blocked);
		via = source.via;
		audit = source.audit;
		notifyOwners = source.notifyOwners;
	}

	// key scopes intersected with the issuer's current standing
	if (principal.kind === 'key') {
		if (!facts.key || facts.key.id !== principal.keyId) return deny('key_scope');
		const denial = keyAllows(facts.key, action, resource, facts.now);
		if (denial) return deny(denial);
	}

	// policy groups, then the action's own step-up rule
	const fresh = stepUpFresh(principal, facts);
	const block = evaluatePolicy(facts.policy, action, { stepUp: fresh });
	if (block) return deny(block.reason, { policy: block.policy, rule: block.rule });
	if (def.stepUp && !fresh)
		return deny('step_up_required', { policy: 'built-in', rule: 'step-up' });

	if (def.entitlement && !facts.entitlements.includes(def.entitlement)) {
		return deny('entitlement_required', { feature: def.entitlement });
	}
	if (def.budget && facts.budgetExceeded.includes(def.budget)) {
		return deny('budget_exceeded', { budget: def.budget });
	}

	return { allow: true, via, audit, ...(notifyOwners ? { notifyOwners } : {}) };
}

export function permittedActions(input: Omit<AuthorizeInput, 'action'>): Action[] {
	return ACTIONS.filter((action) => authorize({ ...input, action }).allow);
}
