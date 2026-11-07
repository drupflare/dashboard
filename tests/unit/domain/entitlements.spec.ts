import { describe, expect, it } from 'vitest';
import {
	ASSURANCE_BASE_ID,
	FEATURES,
	FREE_PLAN_ID,
	canActivate,
	check,
	derive,
	entitlementKeys,
	isFeature,
	siteLimits,
	type Entitlement
} from '../../../src/server/domain/entitlements';
import { PLANS, SUPPORT_LEVELS, findPlan, type Plan } from '../../../src/shared/plans';

const of = (id: string, addOns: string[] = []): Entitlement => {
	const result = derive(id, addOns);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

const LADDER = [
	'managed-free',
	'managed-site',
	'managed-studio',
	'managed-agency',
	'institution-starter',
	'institution-standard'
];

describe('derive', () => {
	it('derives an entitlement for every plan that is not disabled', () => {
		for (const plan of PLANS) {
			const result = derive(plan.id);
			if (plan.disabled)
				expect(result, plan.id).toEqual({ ok: false, reason: 'plan_disabled' });
			else expect(result.ok, plan.id).toBe(true);
		}
	});

	it('copies the figures of the free plan', () => {
		expect(of(FREE_PLAN_ID)).toMatchObject({
			sites: 3,
			views: 100000,
			viewsPooled: true,
			support: 'community',
			environments: false,
			customDomains: 0,
			dashboard: true,
			features: { customCode: false, strata: false, privateSites: true, ssoSaml: false }
		});
	});

	it('keeps an unknown figure null and never turns it into zero', () => {
		const enterprise = of('enterprise');
		expect(enterprise.sites).toBeNull();
		expect(enterprise.backupDays).toBeNull();
		expect(of('managed-site').backupDays).toBeNull();
		expect(of('managed-site').nodes).toBeNull();
	});

	it('trips each typed error once', () => {
		expect(derive('nope')).toEqual({ ok: false, reason: 'unknown_plan' });
		expect(derive('gmux-compute')).toEqual({ ok: false, reason: 'plan_disabled' });
		expect(derive(ASSURANCE_BASE_ID, ['managed-site'])).toEqual({
			ok: false,
			reason: 'not_an_add_on'
		});
		expect(derive('managed-site', ['assurance'])).toEqual({
			ok: false,
			reason: 'add_on_needs_standard'
		});
		expect(derive(ASSURANCE_BASE_ID, ['nope'])).toEqual({ ok: false, reason: 'unknown_plan' });
		expect(derive(ASSURANCE_BASE_ID, ['gmux-compute'])).toEqual({
			ok: false,
			reason: 'plan_disabled'
		});
	});

	it('adds the assurance flag to the standard plan and leaves the figures alone', () => {
		const plain = of(ASSURANCE_BASE_ID);
		const assured = of(ASSURANCE_BASE_ID, ['assurance']);
		expect(plain.assurance).toBe(false);
		expect(assured).toEqual({ ...plain, assurance: true, addOns: ['assurance'] });
	});
});

describe('monotonic ladder', () => {
	const plans = LADDER.map((id) => findPlan(id) as Plan);

	it('lowers the site count only where the roadmap says so: Site holds 1, Free holds 3', () => {
		const drops: string[] = [];
		for (let i = 1; i < plans.length; i++) {
			const a = (plans[i - 1] as Plan).sites.value as number;
			const b = (plans[i] as Plan).sites.value as number;
			if (b < a) drops.push((plans[i] as Plan).id);
		}
		expect(drops).toEqual(['managed-site']);
	});

	it('never lowers a stated hours or domain limit as the plan rises', () => {
		const numeric = ['supportHours', 'customDomains'] as const;
		for (let i = 1; i < plans.length; i++) {
			const lower = plans[i - 1] as Plan;
			const higher = plans[i] as Plan;
			for (const key of numeric) {
				const a = lower[key].value;
				const b = higher[key].value;
				if (a !== null && b !== null)
					expect(b, `${higher.id}.${key}`).toBeGreaterThanOrEqual(a);
			}
		}
	});

	it('lowers views only where the roadmap says so: Starter holds 15 million, Agency 20 million', () => {
		const drops: string[] = [];
		for (let i = 1; i < plans.length; i++) {
			const a = (plans[i - 1] as Plan).views.value as number;
			const b = (plans[i] as Plan).views.value as number;
			if (b < a) drops.push((plans[i] as Plan).id);
		}
		expect(drops).toEqual(['institution-starter']);
	});

	it('never takes a feature away that a lower plan states', () => {
		for (let i = 1; i < plans.length; i++) {
			const lower = plans[i - 1] as Plan;
			const higher = plans[i] as Plan;
			for (const key of [
				'privateSites',
				'rollback',
				'upgrade',
				'customCode',
				'strata',
				'staging',
				'ssoSaml'
			] as const) {
				expect(lower[key] === true && higher[key] === false, `${higher.id}.${key}`).toBe(
					false
				);
			}
		}
	});

	it('never lowers the support level', () => {
		const rank = (id: string) => SUPPORT_LEVELS.indexOf((findPlan(id) as Plan).supportLevel);
		for (let i = 1; i < LADDER.length; i++) {
			expect(rank(LADDER[i] as string)).toBeGreaterThanOrEqual(rank(LADDER[i - 1] as string));
		}
	});

	it('derives a feature only from a flag the plan states as true', () => {
		for (const plan of plans) {
			const features = of(plan.id).features;
			expect(features.privateSites, plan.id).toBe(plan.privateSites === true);
			expect(features.customCode, plan.id).toBe(plan.customCode === true);
			expect(features.ssoSaml, plan.id).toBe(plan.ssoSaml === true);
		}
	});
});

describe('canActivate', () => {
	it('refuses an entitlement with single sign-on while sso.built is false', () => {
		const standard = of(ASSURANCE_BASE_ID);
		expect(standard.features.ssoSaml).toBe(true);
		expect(canActivate(standard, { ssoBuilt: false })).toEqual({
			ok: false,
			reason: 'sso_not_built'
		});
		expect(canActivate(of(ASSURANCE_BASE_ID, ['assurance']), { ssoBuilt: false }).ok).toBe(
			false
		);
		expect(canActivate(standard, { ssoBuilt: true })).toEqual({ ok: true });
	});

	it('lets every plan without single sign-on activate with the flag off', () => {
		for (const plan of PLANS) {
			const result = derive(plan.id);
			if (!result.ok || result.entitlement.features.ssoSaml) continue;
			expect(canActivate(result.entitlement, { ssoBuilt: false }), plan.id).toEqual({
				ok: true
			});
		}
	});
});

describe('check', () => {
	it('denies by default: no entitlement, an unknown action and a plan without the dashboard', () => {
		expect(check('site.create', null, { sitesInOrg: 0 })).toEqual({
			allow: false,
			reason: 'no_entitlement'
		});
		expect(check('site.explode', of('managed-site'), { sitesInOrg: 0 })).toEqual({
			allow: false,
			reason: 'unknown_action'
		});
		expect(check('site.create', of('self-managed'), { sitesInOrg: 0 })).toEqual({
			allow: false,
			reason: 'dashboard_not_included'
		});
	});

	it('allows a site up to the limit and refuses the next one', () => {
		const studio = of('managed-studio');
		expect(check('site.create', studio, { sitesInOrg: 4 })).toEqual({ allow: true });
		expect(check('site.create', studio, { sitesInOrg: 5 })).toEqual({
			allow: false,
			reason: 'site_limit'
		});
	});

	it('does not hold a platform admin to the site count', () => {
		const free = of(FREE_PLAN_ID);
		const facts = { sitesInOrg: 9, freeSitesOwnedByUser: 9, platformAdmin: true };
		expect(check('site.create', free, facts)).toEqual({ allow: true });
		expect(check('site.create', of('enterprise'), facts)).toEqual({ allow: true });
		expect(check('site.create', free, { ...facts, platformAdmin: false })).toEqual({
			allow: false,
			reason: 'site_limit'
		});
	});

	it('refuses site creation when the limit is unknown', () => {
		expect(check('site.create', of('enterprise'), { sitesInOrg: 0 })).toEqual({
			allow: false,
			reason: 'unknown_limit'
		});
	});

	it('counts the free limit per user across organisations', () => {
		const free = of(FREE_PLAN_ID);
		expect(check('site.create', free, { sitesInOrg: 1, freeSitesOwnedByUser: 2 })).toEqual({
			allow: true
		});
		expect(check('site.create', free, { sitesInOrg: 1, freeSitesOwnedByUser: 3 })).toEqual({
			allow: false,
			reason: 'free_limit'
		});
		expect(check('site.create', free, { sitesInOrg: 3, freeSitesOwnedByUser: 3 })).toEqual({
			allow: false,
			reason: 'site_limit'
		});
	});

	it('allows a custom Worker only on a paid plan', () => {
		const facts = { sitesInOrg: 0, customWorker: true };
		expect(check('site.create', of(FREE_PLAN_ID), facts)).toEqual({
			allow: false,
			reason: 'feature_not_included'
		});
		expect(check('site.create', of('managed-site'), facts)).toEqual({ allow: true });
	});

	it('answers each feature flag from the entitlement and denies a flag the plan does not state', () => {
		const site = of('managed-site');
		for (const feature of FEATURES) {
			expect(isFeature(feature)).toBe(true);
			expect(check(feature, site, { sitesInOrg: 0 }).allow, feature).toBe(
				site.features[feature]
			);
		}
		expect(check('customCode', site, { sitesInOrg: 0 })).toEqual({ allow: true });
		expect(check('strata', site, { sitesInOrg: 0 })).toEqual({
			allow: false,
			reason: 'feature_not_included'
		});
		expect(isFeature('site.create')).toBe(false);
	});
});

describe('keys and limits', () => {
	it('names the entitlements the authorizer reads', () => {
		expect(entitlementKeys(null)).toEqual([]);
		expect(entitlementKeys(of(FREE_PLAN_ID))).toEqual([]);
		expect(entitlementKeys(of('managed-site'))).toEqual(['environments']);
		expect(entitlementKeys(of(ASSURANCE_BASE_ID))).toEqual(['sso']);
		expect(entitlementKeys(of('self-managed'))).toEqual([]);
	});

	it('turns only known figures into limits', () => {
		expect(siteLimits(of('managed-site'))).toEqual({ views: 500000, customDomains: 3 });
		expect(siteLimits(of('enterprise'))).toEqual({});
	});
});
