import { describe, expect, it } from 'vitest';
import { authorize, permittedActions, stepUpFresh } from '../../../src/server/domain/authorize';
import { acceptDelegation, createDelegation } from '../../../src/server/domain/delegation';
import type { PolicyGroup } from '../../../src/server/domain/policy';
import {
	ACTIONS,
	ORG_ROLES,
	ORG_ROLE_ACTIONS,
	SITE_ROLES,
	SITE_ROLE_ACTIONS,
	STEP_UP_WINDOW_MS,
	actionDef,
	isSessionOnly,
	type Action,
	type OrgRole
} from '../../../src/shared/permissions';
import {
	AGENCY,
	DEPT,
	NOW,
	ORG,
	OTHER_ORG,
	SITE,
	admin,
	check,
	facts,
	fresh,
	keyPrincipal,
	member,
	resource,
	user
} from './fixtures';

const dashboardActions = ACTIONS.filter((a) => {
	const scope = actionDef(a).scope;
	return scope !== 'admin' && scope !== 'account';
});

const denyDeploy: PolicyGroup = {
	id: 'freeze',
	name: 'Change freeze',
	rules: [{ id: 'no-deploys', deny: ['site.deploy', 'site.rollback'] }]
};

describe('authorize: the table walk', () => {
	it('allows every action for every organisation role exactly as the table says', () => {
		for (const role of ORG_ROLES) {
			const f = facts({ ...member(role), ...fresh });
			for (const action of dashboardActions) {
				const want = ORG_ROLE_ACTIONS[role].includes(action) ? 'allow' : 'forbidden';
				expect(check(action, f), `${role} ${action}`).toBe(want);
			}
		}
	});

	it('allows every action for every site role exactly as the table says', () => {
		for (const role of SITE_ROLES) {
			const f = facts({
				...fresh,
				grants: [{ level: 'site', orgId: ORG, targetId: SITE, role }]
			});
			for (const action of dashboardActions) {
				const want = SITE_ROLE_ACTIONS[role].includes(action) ? 'allow' : 'forbidden';
				expect(check(action, f), `${role} ${action}`).toBe(want);
			}
		}
	});

	it('gives a department grant the role actions below the organisation and nothing above', () => {
		for (const role of ORG_ROLES) {
			const f = facts({
				...fresh,
				grants: [{ level: 'department', orgId: ORG, targetId: DEPT, role }]
			});
			for (const action of dashboardActions) {
				const below = actionDef(action).scope !== 'org';
				const want =
					below && ORG_ROLE_ACTIONS[role].includes(action) ? 'allow' : 'forbidden';
				expect(check(action, f), `${role} ${action}`).toBe(want);
			}
		}
	});

	it('denies a platform admin action to every organisation role', () => {
		for (const role of ORG_ROLES) {
			for (const action of ACTIONS.filter((a) => actionDef(a).scope === 'admin')) {
				expect(
					check(action, facts({ ...member(role), ...fresh })),
					`${role} ${action}`
				).toBe('platform_denied');
			}
		}
	});
});

describe('authorize: default deny', () => {
	it('denies an unknown action', () => {
		expect(check('site.explode', facts({ ...member('owner') }))).toBe('unknown_action');
		expect(check('toString', facts({ ...member('owner') }))).toBe('unknown_action');
	});

	it('denies an unknown role without throwing', () => {
		for (const role of ['god', 'constructor', '']) {
			const f = facts({ membership: { orgId: ORG, role: role as OrgRole } });
			expect(check('site.read', f)).toBe('forbidden');
		}
	});

	it('denies a user with no relation to the organisation', () => {
		expect(check('site.read', facts())).toBe('not_a_member');
		expect(check('site.read', facts({ membership: { orgId: OTHER_ORG, role: 'owner' } }))).toBe(
			'not_a_member'
		);
	});

	it('denies a grant that belongs to another organisation, department or site', () => {
		const wrong = [
			{
				level: 'site' as const,
				orgId: OTHER_ORG,
				targetId: SITE,
				role: 'site-admin' as const
			},
			{ level: 'site' as const, orgId: ORG, targetId: 'site-9', role: 'site-admin' as const },
			{ level: 'department' as const, orgId: ORG, targetId: 'dept-9', role: 'owner' as const }
		];
		const reasons = wrong.map((grant) => check('site.read', facts({ grants: [grant] })));
		expect(reasons).toEqual(['not_a_member', 'forbidden', 'forbidden']);
	});

	it('requires the ids the action addresses', () => {
		const f = facts({ ...member('owner') });
		expect(check('site.read', f, { resource: {} })).toBe('bad_resource');
		expect(check('site.read', f, { resource: undefined })).toBe('bad_resource');
		expect(check('site.read', f, { resource: { orgId: ORG } })).toBe('bad_resource');
		expect(check('org.read', f, { resource: { orgId: ORG } })).toBe('allow');
	});

	it('lets any signed-in user read their own account', () => {
		expect(check('account.read', facts(), { resource: undefined })).toBe('allow');
	});
});

describe('authorize: evaluation order', () => {
	it('lets a platform flag beat a grant, and walks the stages in the plan order', () => {
		const owner = member('owner');
		const noDelete: PolicyGroup = {
			id: 'keep',
			name: 'Keep sites',
			rules: [{ id: 'no-delete', deny: ['site.delete'] }]
		};
		// site.delete carries a step-up rule and a budget, so every stage can fail on it
		const steps: [string, Parameters<typeof facts>[0]][] = [
			[
				'user_suspended',
				{
					flags: { userSuspended: true, suspendedOrgIds: [ORG] },
					...owner,
					policy: [noDelete]
				}
			],
			['org_suspended', { flags: { suspendedOrgIds: [ORG] }, ...owner }],
			['not_a_member', {}],
			['forbidden', { ...member('viewer'), policy: [noDelete] }],
			[
				'policy_denied',
				{ ...owner, policy: [noDelete], budgetExceeded: ['destructive-sites'] }
			],
			['step_up_required', { ...owner, budgetExceeded: ['destructive-sites'] }],
			['budget_exceeded', { ...owner, ...fresh, budgetExceeded: ['destructive-sites'] }],
			['allow', { ...owner, ...fresh }]
		];
		for (const [want, over] of steps) {
			expect(check('site.delete', facts(over)), want).toBe(want);
		}
	});

	it('walks the key stages before policy and policy before entitlement', () => {
		const base = { ...member('owner'), policy: [denyDeploy] };
		expect(check('site.deploy', facts(base), { principal: keyPrincipal })).toBe('key_scope');
		const key = { id: 'key-1', scopes: ['site.deploy'] };
		expect(check('site.deploy', facts({ ...base, key }), { principal: keyPrincipal })).toBe(
			'policy_denied'
		);
		const noFeature = facts({
			...member('owner'),
			entitlements: [],
			policy: [
				{ id: 'p', name: 'p', rules: [{ id: 'r', deny: ['site.environment.manage'] }] }
			]
		});
		expect(check('site.environment.manage', noFeature)).toBe('policy_denied');
		expect(check('site.environment.manage', { ...noFeature, policy: [] })).toBe(
			'entitlement_required'
		);
	});
});

describe('authorize: platform flags', () => {
	it('denies a suspended user everything, including admin actions', () => {
		const f = facts({ ...admin, ...member('owner'), flags: { userSuspended: true } });
		expect(check('site.read', f)).toBe('user_suspended');
		expect(check('admin.aggregates.read', f, { resource: undefined })).toBe('user_suspended');
	});

	it('keeps billing, org read and audit open in a suspended organisation', () => {
		const f = facts({ ...member('owner'), flags: { suspendedOrgIds: [ORG] } });
		expect(check('billing.read', f)).toBe('allow');
		expect(check('audit.read', f)).toBe('allow');
		expect(check('site.deploy', f)).toBe('org_suspended');
		expect(check('member.invite', f)).toBe('org_suspended');
	});
});

describe('authorize: platform admin', () => {
	const admin_ = (action: string, f = facts(admin), p = user) =>
		check(action, f, { principal: p, resource: undefined });

	it('needs the flag, the Access fact and the named permission', () => {
		expect(admin_('admin.aggregates.read')).toBe('allow');
		expect(admin_('admin.aggregates.read', facts())).toBe('platform_denied');
		const noAccess = facts({ platform: { ...admin.platform!, access: false } });
		expect(admin_('admin.aggregates.read', noAccess)).toBe('platform_denied');
		const notAdmin = facts({ platform: { ...admin.platform!, admin: false } });
		expect(admin_('admin.aggregates.read', notAdmin)).toBe('platform_denied');
	});

	it('keeps billing support and infrastructure authority separate', () => {
		const billingOnly = facts({
			platform: { admin: true, access: true, permissions: ['billing_support'] }
		});
		expect(admin_('admin.billing.support', billingOnly)).toBe('allow');
		expect(admin_('admin.infrastructure.manage', billingOnly)).toBe('platform_denied');
		expect(admin_('admin.metadata.read', billingOnly)).toBe('platform_denied');
		const infraOnly = facts({
			platform: { admin: true, access: true, permissions: ['infrastructure'] }
		});
		expect(admin_('admin.infrastructure.manage', infraOnly)).toBe('allow');
		expect(admin_('admin.billing.support', infraOnly)).toBe('platform_denied');
	});

	it('refuses an API key for every admin action', () => {
		for (const action of ACTIONS.filter((a) => actionDef(a).scope === 'admin')) {
			expect(admin_(action, facts({ ...admin, ...fresh }), keyPrincipal)).toBe(
				'session_only'
			);
		}
	});

	it('does not give an admin membership in a customer organisation', () => {
		expect(check('site.read', facts(admin))).toBe('not_a_member');
	});
});

describe('authorize: support grants and break-glass', () => {
	const support = (over = {}) => ({
		supportGrant: { orgId: ORG, role: 'developer' as const, expiresAt: NOW + 3600_000, ...over }
	});

	it('lets an admin act inside the organisation under a live support grant', () => {
		const d = authorize({
			principal: user,
			action: 'site.deploy',
			resource,
			facts: facts({ ...admin, ...support() })
		});
		expect(d).toMatchObject({ allow: true, via: 'support-grant', audit: [ORG] });
	});

	it('ends access when the support grant expires', () => {
		const f = facts({ ...admin, ...support({ expiresAt: NOW }) });
		expect(check('site.deploy', f)).toBe('support_grant_expired');
		expect(check('site.deploy', facts({ ...admin, ...support({ expiresAt: NOW + 1 }) }))).toBe(
			'allow'
		);
	});

	it('limits a support grant to its role and its sites', () => {
		const viewer = facts({ ...admin, ...support({ role: 'viewer' }) });
		expect(check('site.read', viewer)).toBe('allow');
		expect(check('site.deploy', viewer)).toBe('forbidden');
		const sited = facts({ ...admin, ...support({ siteIds: ['site-9'] }) });
		expect(check('site.deploy', sited)).toBe('forbidden');
		expect(check('org.update', facts({ ...admin, ...support({ role: 'developer' }) }))).toBe(
			'forbidden'
		);
	});

	it('ignores a support grant held by someone who is not a platform admin', () => {
		expect(check('site.deploy', facts(support()))).toBe('not_a_member');
		const noSupport = facts({
			platform: { admin: true, access: true, permissions: ['read'] },
			...support()
		});
		expect(check('site.deploy', noSupport)).toBe('not_a_member');
	});

	it('refuses break-glass without step-up and without a typed reason', () => {
		const bg = { breakGlass: { orgId: ORG, reason: 'site is down' } };
		expect(check('site.rollback', facts({ ...admin, ...bg }))).toBe('step_up_required');
		const stale = { stepUpAt: NOW - STEP_UP_WINDOW_MS - 1 };
		expect(check('site.rollback', facts({ ...admin, ...bg, ...stale }))).toBe(
			'step_up_required'
		);
		const blank = { breakGlass: { orgId: ORG, reason: '   ' } };
		expect(check('site.rollback', facts({ ...admin, ...blank, ...fresh }))).toBe(
			'break_glass_invalid'
		);
	});

	it('allows break-glass with a reason and step-up, and asks to notify the owners', () => {
		const f = facts({ ...admin, ...fresh, breakGlass: { orgId: ORG, reason: 'site is down' } });
		expect(authorize({ principal: user, action: 'site.rollback', resource, facts: f })).toEqual(
			{
				allow: true,
				via: 'break-glass',
				audit: [ORG],
				notifyOwners: ORG
			}
		);
		expect(check('billing.manage', f)).toBe('forbidden');
		expect(check('member.invite', f)).toBe('forbidden');
	});

	it('never lets an admin read site content, under any route in', () => {
		const content = ACTIONS.filter((a) => actionDef(a).content);
		expect(content.length).toBeGreaterThan(0);
		const routes = [
			facts({ ...admin, ...support() }),
			facts({ ...admin, ...fresh, breakGlass: { orgId: ORG, reason: 'incident' } })
		];
		for (const f of routes) {
			for (const action of content) expect(check(action, f), action).toBe('forbidden');
		}
	});
});

describe('authorize: delegation', () => {
	const delegation = (role: 'maintainer' | 'viewer', over = {}) => {
		const created = createDelegation({
			id: 'd1',
			clientOrgId: ORG,
			agencyOrgId: AGENCY,
			role,
			sites: [SITE],
			createdBy: 'client-owner',
			now: NOW - 100,
			...over
		});
		if (!created.ok) throw new Error(created.reason);
		const accepted = acceptDelegation(created.delegation, { orgId: AGENCY, now: NOW - 50 });
		if (!accepted.ok) throw new Error(accepted.reason);
		return accepted.delegation;
	};
	const agencyFacts = (role: OrgRole, d = delegation('maintainer')) =>
		facts({ delegations: [d], agencyMemberships: [{ orgId: AGENCY, role }] });

	it('lets an agency developer act under a maintainer delegation and audits both sides', () => {
		const d = authorize({
			principal: user,
			action: 'site.deploy',
			resource,
			facts: agencyFacts('developer')
		});
		expect(d).toMatchObject({ allow: true, via: 'delegation', audit: [ORG, AGENCY] });
	});

	it('caps the result at the lower of the delegation role and the member role', () => {
		for (const role of ORG_ROLES) {
			for (const dRole of ['maintainer', 'viewer'] as const) {
				const f = agencyFacts(role, delegation(dRole));
				const delegated = SITE_ROLE_ACTIONS[dRole];
				const member_ = ORG_ROLE_ACTIONS[role];
				for (const action of dashboardActions) {
					const inBoth =
						actionDef(action).scope === 'site' &&
						delegated.includes(action) &&
						member_.includes(action);
					expect(check(action, f), `${role}/${dRole} ${action}`).toBe(
						inBoth ? 'allow' : 'forbidden'
					);
				}
			}
		}
	});

	it('never reaches organisation-level actions or other sites', () => {
		const f = agencyFacts('owner');
		expect(check('org.read', f)).toBe('forbidden');
		expect(check('billing.read', f)).toBe('forbidden');
		expect(check('site.read', f, { resource: { orgId: ORG, siteId: 'site-9' } })).toBe(
			'forbidden'
		);
	});

	it('covers every site of the client when the delegation says all', () => {
		const f = agencyFacts('admin', delegation('viewer', { sites: 'all' }));
		expect(check('site.read', f, { resource: { orgId: ORG, siteId: 'site-9' } })).toBe('allow');
	});

	it('ends access when either side revokes, the member leaves or the delegation expires', () => {
		const live = agencyFacts('admin');
		expect(check('site.deploy', live)).toBe('allow');
		const revoked = { ...delegation('maintainer'), status: 'revoked' as const };
		expect(check('site.deploy', agencyFacts('admin', revoked))).toBe('forbidden');
		const left = facts({ delegations: [delegation('maintainer')], agencyMemberships: [] });
		expect(check('site.deploy', left)).toBe('not_a_member');
		const expiring = delegation('maintainer', { expiresAt: NOW + 10 });
		expect(check('site.deploy', agencyFacts('admin', expiring))).toBe('allow');
		expect(check('site.deploy', { ...agencyFacts('admin', expiring), now: NOW + 10 })).toBe(
			'forbidden'
		);
	});

	it('does not apply a delegation for another client', () => {
		const other = { ...delegation('maintainer'), clientOrgId: OTHER_ORG };
		expect(check('site.deploy', agencyFacts('admin', other))).toBe('not_a_member');
	});
});

describe('authorize: policy, step-up, entitlement and budget', () => {
	it('lets a policy cap beat a broader grant and names the policy and rule', () => {
		const f = facts({ ...member('owner'), policy: [denyDeploy] });
		const d = authorize({ principal: user, action: 'site.deploy', resource, facts: f });
		expect(d).toEqual({
			allow: false,
			reason: 'policy_denied',
			detail: { policy: 'freeze', rule: 'no-deploys' }
		});
		expect(check('site.read', f)).toBe('allow');
	});

	it('applies the policy to a site grant and a delegation as well', () => {
		const grant = facts({
			grants: [{ level: 'site', orgId: ORG, targetId: SITE, role: 'site-admin' }],
			policy: [denyDeploy]
		});
		expect(check('site.deploy', grant)).toBe('policy_denied');
	});

	it('enforces a policy step-up rule and clears it with a fresh step-up', () => {
		const policy: PolicyGroup[] = [
			{ id: 'restricted', name: 'Restricted', rules: [{ id: 'su', stepUp: ['site.deploy'] }] }
		];
		const f = facts({ ...member('owner'), policy });
		expect(check('site.deploy', f)).toBe('step_up_required');
		expect(check('site.deploy', { ...f, ...fresh })).toBe('allow');
	});

	it('requires a fresh step-up for step-up actions and expires it', () => {
		const f = facts({ ...member('owner') });
		expect(check('site.transfer', f)).toBe('step_up_required');
		expect(check('site.transfer', { ...f, stepUpAt: NOW - STEP_UP_WINDOW_MS })).toBe('allow');
		expect(check('site.transfer', { ...f, stepUpAt: NOW - STEP_UP_WINDOW_MS - 1 })).toBe(
			'step_up_required'
		);
		expect(check('site.transfer', { ...f, stepUpAt: NOW + 5000 })).toBe('step_up_required');
	});

	it('reads freshness from the principal kind', () => {
		expect(stepUpFresh(user, facts(fresh))).toBe(true);
		expect(stepUpFresh(keyPrincipal, facts(fresh))).toBe(false);
		expect(stepUpFresh(user, facts())).toBe(false);
	});

	it('gates an action on a plan feature', () => {
		const f = facts({ ...member('owner'), entitlements: [] });
		const d = authorize({ principal: user, action: 'org.sso.manage', resource, facts: f });
		expect(d).toEqual({
			allow: false,
			reason: 'entitlement_required',
			detail: { feature: 'sso' }
		});
		expect(check('org.sso.manage', { ...f, entitlements: ['sso'] })).toBe('allow');
	});

	it('refuses an action whose change budget is spent', () => {
		const f = facts({ ...member('owner'), ...fresh, budgetExceeded: ['destructive-sites'] });
		const d = authorize({ principal: user, action: 'site.delete', resource, facts: f });
		expect(d).toEqual({
			allow: false,
			reason: 'budget_exceeded',
			detail: { budget: 'destructive-sites' }
		});
		expect(check('site.deploy', f)).toBe('allow');
	});
});

describe('authorize: api keys', () => {
	const keyFacts = (scopes: readonly string[], over = {}, role: OrgRole = 'owner') =>
		facts({ ...member(role), ...fresh, key: { id: 'key-1', scopes, ...over } });
	const asKey = (action: string, f: ReturnType<typeof facts>) =>
		check(action, f, { principal: keyPrincipal });

	it('never gains an action its issuer lacks', () => {
		for (const role of ORG_ROLES) {
			const f = keyFacts(ACTIONS, {}, role);
			const issuer = new Set(permittedActions({ principal: user, resource, facts: f }));
			for (const action of ACTIONS) {
				if (asKey(action, f) === 'allow')
					expect(issuer.has(action), `${role} ${action}`).toBe(true);
			}
		}
	});

	it('follows the issuer down when the issuer loses a role', () => {
		const scopes = ['site.deploy', 'site.read'];
		expect(asKey('site.deploy', keyFacts(scopes, {}, 'developer'))).toBe('allow');
		expect(asKey('site.deploy', keyFacts(scopes, {}, 'viewer'))).toBe('forbidden');
		expect(asKey('site.read', keyFacts(scopes, {}, 'viewer'))).toBe('allow');
	});

	it('refuses a key every session-only action even when scoped and held', () => {
		const sessionOnly = ACTIONS.filter(
			(a) => isSessionOnly(a) && actionDef(a).scope !== 'admin'
		);
		expect(sessionOnly.length).toBeGreaterThan(0);
		const f = keyFacts(ACTIONS);
		for (const action of sessionOnly) {
			expect(asKey(action, f), action).toBe('session_only');
		}
	});

	it('refuses a key every step-up action', () => {
		const f = keyFacts(ACTIONS);
		for (const action of ACTIONS.filter((a) => actionDef(a).stepUp && !isSessionOnly(a))) {
			expect(asKey(action, f), action).toBe('step_up_required');
		}
	});

	it('denies an action outside the key scopes', () => {
		expect(asKey('site.read', keyFacts(['site.deploy']))).toBe('key_scope');
	});

	it('denies a key with no facts, mismatched facts, a revoked or an expired state', () => {
		expect(asKey('site.read', facts({ ...member('owner') }))).toBe('key_scope');
		expect(asKey('site.read', keyFacts(['site.read'], { id: 'other' }))).toBe('key_scope');
		expect(asKey('site.read', keyFacts(['site.read'], { revokedAt: NOW }))).toBe('key_revoked');
		expect(asKey('site.read', keyFacts(['site.read'], { expiresAt: NOW }))).toBe('key_expired');
		expect(asKey('site.read', keyFacts(['site.read'], { expiresAt: NOW + 1 }))).toBe('allow');
	});

	it('restricts a key to an organisation or a site set', () => {
		expect(asKey('site.read', keyFacts(['site.read'], { orgIds: [OTHER_ORG] }))).toBe(
			'key_scope'
		);
		expect(asKey('site.read', keyFacts(['site.read'], { orgIds: [ORG] }))).toBe('allow');
		expect(asKey('site.read', keyFacts(['site.read'], { siteIds: ['site-9'] }))).toBe(
			'key_scope'
		);
		expect(asKey('site.read', keyFacts(['site.read'], { siteIds: [SITE] }))).toBe('allow');
		expect(asKey('org.read', keyFacts(['org.read'], { siteIds: [SITE] }))).toBe('key_scope');
	});
});

describe('permittedActions', () => {
	it('lists what a role holds on a resource', () => {
		const got = permittedActions({
			principal: user,
			resource,
			facts: facts({ ...member('viewer'), ...fresh })
		});
		const want = ORG_ROLE_ACTIONS.viewer.filter(Boolean);
		expect(got.filter((a) => actionDef(a).scope !== 'account')).toEqual(want);
		expect(got).toContain('account.read' as Action);
	});
});
