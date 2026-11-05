import { describe, expect, it } from 'vitest';
import {
	acceptDelegation,
	coversSite,
	createDelegation,
	delegatedActions,
	delegationAudit,
	isActive,
	revokeDelegation,
	type Delegation
} from '../../../src/server/domain/delegation';
import {
	ORG_ROLES,
	ORG_ROLE_ACTIONS,
	SITE_ROLE_ACTIONS,
	actionDef
} from '../../../src/shared/permissions';

const base = {
	id: 'd1',
	clientOrgId: 'client',
	agencyOrgId: 'agency',
	role: 'maintainer',
	sites: ['s1'],
	createdBy: 'u1',
	now: 100
};

function pending(over: Partial<typeof base> & { expiresAt?: number } = {}): Delegation {
	const r = createDelegation({ ...base, ...over });
	if (!r.ok) throw new Error(r.reason);
	return r.delegation;
}

describe('delegation lifecycle', () => {
	it('creates a pending delegation', () => {
		expect(pending()).toMatchObject({ status: 'pending', role: 'maintainer', createdAt: 100 });
	});

	it('trips every creation error once', () => {
		const reason = (over: object) => {
			const r = createDelegation({ ...base, ...over });
			return r.ok ? 'ok' : r.reason;
		};
		expect(reason({ agencyOrgId: 'client' })).toBe('same_org');
		expect(reason({ role: 'site-admin' })).toBe('bad_role');
		expect(reason({ role: 'owner' })).toBe('bad_role');
		expect(reason({ expiresAt: 100 })).toBe('bad_expiry');
		expect(reason({ sites: [] })).toBe('no_sites');
		expect(reason({ sites: 'all' })).toBe('ok');
	});

	it('lets the agency accept and refuses everyone else', () => {
		const d = pending();
		const ok = acceptDelegation(d, { orgId: 'agency', now: 200 });
		expect(ok).toMatchObject({ ok: true, delegation: { status: 'active', acceptedAt: 200 } });
		expect(acceptDelegation(d, { orgId: 'client', now: 200 })).toEqual({
			ok: false,
			reason: 'wrong_side'
		});
		expect(acceptDelegation(d, { orgId: 'stranger', now: 200 })).toEqual({
			ok: false,
			reason: 'not_party'
		});
	});

	it('refuses to accept twice, after expiry or after revocation', () => {
		const active = (
			acceptDelegation(pending(), { orgId: 'agency', now: 150 }) as { delegation: Delegation }
		).delegation;
		expect(acceptDelegation(active, { orgId: 'agency', now: 160 })).toEqual({
			ok: false,
			reason: 'not_pending'
		});
		const expiring = pending({ expiresAt: 300 });
		expect(acceptDelegation(expiring, { orgId: 'agency', now: 300 })).toEqual({
			ok: false,
			reason: 'expired'
		});
		const revoked = (
			revokeDelegation(pending(), { orgId: 'client', now: 120 }) as { delegation: Delegation }
		).delegation;
		expect(acceptDelegation(revoked, { orgId: 'agency', now: 130 })).toEqual({
			ok: false,
			reason: 'already_revoked'
		});
	});

	it('lets either side revoke and ends access', () => {
		const active = (
			acceptDelegation(pending(), { orgId: 'agency', now: 150 }) as { delegation: Delegation }
		).delegation;
		expect(isActive(active, 200)).toBe(true);
		for (const orgId of ['client', 'agency']) {
			const r = revokeDelegation(active, { orgId, now: 210 });
			expect(r).toMatchObject({
				ok: true,
				delegation: { status: 'revoked', revokedByOrgId: orgId }
			});
			expect(isActive((r as { delegation: Delegation }).delegation, 220)).toBe(false);
		}
	});

	it('refuses a revocation by a stranger or a repeat revocation', () => {
		const d = pending();
		expect(revokeDelegation(d, { orgId: 'stranger', now: 1 })).toEqual({
			ok: false,
			reason: 'not_party'
		});
		const revoked = (
			revokeDelegation(d, { orgId: 'client', now: 1 }) as { delegation: Delegation }
		).delegation;
		expect(revokeDelegation(revoked, { orgId: 'agency', now: 2 })).toEqual({
			ok: false,
			reason: 'already_revoked'
		});
	});

	it('treats an expiry as the first instant of no access', () => {
		const d = { ...pending({ expiresAt: 500 }), status: 'active' as const };
		expect(isActive(d, 499)).toBe(true);
		expect(isActive(d, 500)).toBe(false);
		expect(isActive(pending(), 1000)).toBe(false);
	});

	it('covers listed sites or all sites', () => {
		expect(coversSite(pending(), 's1')).toBe(true);
		expect(coversSite(pending(), 's2')).toBe(false);
		expect(coversSite(pending(), undefined)).toBe(false);
		expect(coversSite(pending({ sites: 'all' as never }), 's9')).toBe(true);
	});

	it('names both organisations for the audit', () => {
		expect(delegationAudit(pending())).toEqual(['client', 'agency']);
	});
});

describe('delegation math', () => {
	it('is the minimum of the delegation role and the member role', () => {
		for (const dRole of ['maintainer', 'viewer'] as const) {
			for (const role of ORG_ROLES) {
				const got = delegatedActions(dRole, role);
				const delegated = new Set(SITE_ROLE_ACTIONS[dRole]);
				const member = new Set(
					ORG_ROLE_ACTIONS[role].filter((a) => actionDef(a).scope === 'site')
				);
				for (const a of got) {
					expect(delegated.has(a) && member.has(a), `${dRole}/${role} ${a}`).toBe(true);
				}
				for (const a of delegated) expect(got.has(a)).toBe(member.has(a));
			}
		}
	});

	it('gives a viewer delegation read access even to an agency admin', () => {
		const got = delegatedActions('viewer', 'admin');
		expect(got.has('site.read')).toBe(true);
		expect(got.has('site.deploy')).toBe(false);
	});

	it('gives a maintainer delegation to an agency viewer only the viewer actions', () => {
		const got = delegatedActions('maintainer', 'viewer');
		expect(got.has('site.read')).toBe(true);
		expect(got.has('site.deploy')).toBe(false);
	});

	it('gives nothing to a billing member and nothing for an unknown role', () => {
		expect(delegatedActions('maintainer', 'billing').size).toBe(0);
		expect(delegatedActions('maintainer', 'god' as never).size).toBe(0);
		expect(delegatedActions('owner' as never, 'owner').size).toBe(0);
	});
});
