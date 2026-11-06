import { describe, expect, it } from 'vitest';
import { derive, siteLimits, type Entitlement } from '../../../src/server/domain/entitlements';
import {
	DEFAULT_FLAGS,
	reconcile,
	type AppliedSite,
	type Desired,
	type SiteState
} from '../../../src/server/domain/reconcile';

const ent = (id: string): Entitlement => {
	const result = derive(id);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

const applied = (siteId: string, over: Partial<AppliedSite> = {}): AppliedSite => ({
	siteId,
	plan: 'managed-studio',
	limits: siteLimits(ent('managed-studio')),
	state: 'active',
	suspendedBy: null,
	securityPending: false,
	...over
});

const desired = (over: Partial<Desired> = {}): Desired => ({
	orgId: 'org-1',
	revision: 4,
	entitlement: ent('managed-studio'),
	sites: [
		{ siteId: 'a', createdAt: 1 },
		{ siteId: 'b', createdAt: 2 }
	],
	overage: null,
	...over
});

const targets = (r: ReturnType<typeof reconcile>) =>
	r.actions.map((a) => `${a.siteId}:${a.params.target}`);

describe('reconcile', () => {
	it('does nothing when applied state already matches', () => {
		expect(reconcile(desired(), [applied('a'), applied('b')])).toEqual({
			actions: [],
			skipped: []
		});
	});

	it('does nothing without an entitlement', () => {
		expect(
			reconcile(desired({ entitlement: null }), [applied('a', { plan: null })]).actions
		).toEqual([]);
	});

	it('asks for the plan and the limits as operation requests with stable keys', () => {
		const stale = applied('a', { plan: 'managed-site', limits: { views: 1 } });
		const first = reconcile(desired(), [stale]);
		expect(targets(first)).toEqual(['a:plan', 'a:site-auth-limits']);
		expect(first.actions[0]).toEqual({
			type: 'config.apply',
			organizationId: 'org-1',
			siteId: 'a',
			idempotencyKey: 'billing:org-1:r4:a:plan',
			params: { target: 'plan', plan: 'managed-studio' }
		});
		expect(reconcile(desired(), [stale])).toEqual(first);
		const later = reconcile(desired({ revision: 5 }), [stale]);
		expect(later.actions[0]?.idempotencyKey).toBe('billing:org-1:r5:a:plan');
	});

	it('suspends the newest sites beyond the limit and leaves the oldest', () => {
		const sites = [1, 2, 3, 4, 5].map((n) => ({ siteId: `s${n}`, createdAt: n }));
		const result = reconcile(
			desired({ entitlement: ent('managed-free'), sites }),
			sites.map((s) =>
				applied(s.siteId, { plan: 'managed-free', limits: siteLimits(ent('managed-free')) })
			)
		);
		expect(targets(result)).toEqual(['s4:site-auth-state', 's5:site-auth-state']);
		expect(
			result.actions.every(
				(a) => a.params.target === 'site-auth-state' && a.params.state === 'suspended'
			)
		).toBe(true);
	});

	it('breaks a creation-time tie by site id', () => {
		const sites = [
			{ siteId: 'b', createdAt: 1 },
			{ siteId: 'a', createdAt: 1 }
		];
		const result = reconcile(desired({ entitlement: ent('managed-site'), sites }), [
			applied('a', { plan: 'managed-site', limits: siteLimits(ent('managed-site')) }),
			applied('b', { plan: 'managed-site', limits: siteLimits(ent('managed-site')) })
		]);
		expect(targets(result)).toEqual(['b:site-auth-state']);
	});

	it('never suspends when the limit is unknown', () => {
		const result = reconcile(desired({ entitlement: ent('enterprise') }), [
			applied('a'),
			applied('b')
		]);
		expect(result.actions.every((a) => a.params.target !== 'site-auth-state')).toBe(true);
	});

	it('resumes a site that billing suspended and leaves one that security suspended', () => {
		const result = reconcile(desired(), [
			applied('a', { state: 'suspended', suspendedBy: 'billing' }),
			applied('b', { state: 'suspended', suspendedBy: 'security' })
		]);
		expect(targets(result)).toEqual(['a:site-auth-state']);
		expect(result.actions[0]?.params).toEqual({
			target: 'site-auth-state',
			state: 'active',
			reason: 'billing'
		});
	});

	it('skips a site with an unreconciled security state and a revoked site', () => {
		const result = reconcile(desired(), [
			applied('a', { plan: null, limits: {}, securityPending: true }),
			applied('b', { plan: null, limits: {}, state: 'revoked' })
		]);
		expect(result.actions).toEqual([]);
		expect(result.skipped).toEqual([
			{ siteId: 'a', reason: 'security_unreconciled' },
			{ siteId: 'b', reason: 'revoked' }
		]);
	});

	it('lets a security-suspended site lose limits but never gain them', () => {
		const held = { state: 'suspended', suspendedBy: 'security' } as const;
		const raise = reconcile(desired(), [
			applied('a', { ...held, plan: 'managed-site', limits: { views: 1, customDomains: 0 } })
		]);
		expect(raise.actions).toEqual([]);
		const lower = reconcile(desired(), [
			applied('a', {
				...held,
				plan: 'managed-agency',
				limits: { views: 9e9, customDomains: 99 }
			})
		]);
		expect(targets(lower)).toEqual(['a:plan', 'a:site-auth-limits']);
	});

	it('emits no limit raise for a revoked site in any combination of state and limits', () => {
		const states: SiteState[] = ['active', 'plan-grace', 'suspended', 'revoked'];
		const suspenders = [null, 'billing', 'security'] as const;
		const limitSets = [{}, { views: 1 }, siteLimits(ent('managed-agency'))];
		for (const state of states) {
			for (const suspendedBy of suspenders) {
				for (const limits of limitSets) {
					for (const securityPending of [false, true]) {
						const site = applied('a', {
							state,
							suspendedBy,
							limits,
							securityPending,
							plan: null
						});
						const result = reconcile(desired(), [site]);
						if (state === 'revoked' || securityPending)
							expect(result.actions).toEqual([]);
						for (const action of result.actions) {
							if (action.params.target !== 'site-auth-limits') continue;
							if (state === 'suspended' && suspendedBy === 'security') {
								for (const key of Object.keys(limits)) {
									expect(action.params.limits[key]).toBeLessThanOrEqual(
										(limits as Record<string, number>)[key] as number
									);
								}
							}
						}
					}
				}
			}
		}
	});
});

describe('overage', () => {
	const usage = { views: 1200, meterEventId: 'usage:site_a:2026-11-05T00:00:00Z' };
	const sites = [applied('a'), applied('b')];

	it('defaults the flag to off and emits no overage action', () => {
		expect(DEFAULT_FLAGS.overageEnabled).toBe(false);
		expect(reconcile(desired({ overage: usage }), sites).actions).toEqual([]);
		expect(
			reconcile(desired({ overage: usage }), sites, { overageEnabled: false }).actions
		).toEqual([]);
	});

	it('emits one overage request, keyed by the interval id, once the flag is on', () => {
		const result = reconcile(desired({ overage: usage }), sites, { overageEnabled: true });
		expect(result.actions).toEqual([
			{
				type: 'config.apply',
				organizationId: 'org-1',
				siteId: null,
				idempotencyKey: 'billing:org-1:r4:org:meter-overage',
				params: { target: 'meter-overage', views: 1200, meterEventId: usage.meterEventId }
			}
		]);
	});

	it('bills nothing on the free plan and nothing for zero views', () => {
		const on = { overageEnabled: true };
		expect(
			reconcile(
				desired({ entitlement: ent('managed-free'), overage: usage, sites: [] }),
				[],
				on
			).actions
		).toEqual([]);
		expect(reconcile(desired({ overage: { ...usage, views: 0 } }), sites, on).actions).toEqual(
			[]
		);
	});
});
