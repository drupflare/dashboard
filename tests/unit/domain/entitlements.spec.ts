import { describe, expect, it } from 'vitest';
import {
	FEATURES,
	FREE_PLAN_ID,
	canActivate,
	check,
	derive,
	entitlementKeys,
	isFeature,
	managedIsFree,
	siteLimits,
	type AddOnHolding,
	type Entitlement
} from '../../../src/server/domain/entitlements';
import { PLANS, findAddOn, findPlan, type Plan } from '../../../src/shared/plans';

const of = (id: string, holdings: AddOnHolding[] = []): Entitlement => {
	const result = derive(id, holdings);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

const hold = (id: string, quantity = 1): AddOnHolding => ({ id, quantity });

const LADDER = [
	'managed-free',
	'managed-pro',
	'managed-agency',
	'institution-starter',
	'institution-standard'
];

describe('derive', () => {
	it('derives an entitlement for every plan that is not disabled', () => {
		for (const plan of PLANS) {
			const result = derive(plan.id);
			if (plan.disabled) {
				expect(result, plan.id).toEqual({ ok: false, reason: 'plan_disabled' });
			} else {
				expect(result.ok, plan.id).toBe(true);
			}
		}
	});

	it('copies the figures of the free plan', () => {
		expect(of(FREE_PLAN_ID)).toMatchObject({
			planId: 'managed-free',
			managedPlanId: 'managed-free',
			plane: 'managed',
			addOns: [],
			sites: findPlan(FREE_PLAN_ID)?.sites.value,
			views: findPlan(FREE_PLAN_ID)?.views.value,
			viewsPooled: true,
			support: 'community',
			environments: false,
			customDomains: 0,
			dashboard: true,
			assurance: false,
			features: { customCode: false, strata: true, privateSites: true, ssoSaml: false }
		});
	});

	it('copies the figures of Managed Pro', () => {
		const pro = findPlan('managed-pro') as Plan;
		expect(of('managed-pro')).toMatchObject({
			managedPlanId: 'managed-pro',
			sites: pro.sites.value,
			views: pro.views.value,
			storageGb: pro.storageGb.value,
			writes: pro.writes.value,
			backupGb: pro.backupGb.value,
			mailSends: pro.mailSends.value,
			containerHours: pro.containerHours.value,
			invitees: pro.invitees.value,
			supportHoursPerYear: pro.supportHoursPerYear.value,
			support: 'core',
			environments: true,
			customDomains: pro.customDomains.value,
			backupDays: pro.backupDays.value,
			features: { customCode: true, customDomains: true, ssoSaml: false }
		});
	});

	it('keeps an unknown figure null and never turns it into zero', () => {
		const enterprise = of('enterprise');
		expect(enterprise.sites).toBeNull();
		expect(enterprise.backupDays).toBeNull();
		expect(of('institution-starter').writes).toBeNull();
		expect(of('institution-starter').backupGb).toBeNull();
		expect(of('managed-pro').nodes).toBeNull();
	});

	it('leaves a null figure null when an add-on adds to it', () => {
		const grown = of('institution-starter', [hold('backup-storage', 3), hold('writes', 2)]);
		expect(grown.backupGb).toBeNull();
		expect(grown.writes).toBeNull();
		expect(grown.addOns).toEqual([hold('backup-storage', 3), hold('writes', 2)]);
	});

	it('trips each typed error once', () => {
		expect(derive('nope')).toEqual({ ok: false, reason: 'unknown_plan' });
		expect(derive('managed-pro', [hold('nope')])).toEqual({
			ok: false,
			reason: 'unknown_add_on'
		});
		expect(derive('managed-pro', [hold('support-critical')])).toEqual({
			ok: false,
			reason: 'add_on_unavailable'
		});
		expect(derive('managed-pro', [hold('domain')])).toEqual({
			ok: false,
			reason: 'add_on_unavailable'
		});
		expect(derive('managed-free', [hold('extra-site')])).toEqual({
			ok: false,
			reason: 'add_on_not_offered'
		});
		expect(derive('managed-pro', [hold('assurance')])).toEqual({
			ok: false,
			reason: 'add_on_not_offered'
		});
	});

	it('refuses a quantity that is not a whole number of at least one', () => {
		for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(derive('managed-pro', [hold('extra-site', quantity)]), String(quantity)).toEqual(
				{
					ok: false,
					reason: 'bad_quantity'
				}
			);
		}
		expect(derive('managed-pro', [hold('nope', 0)])).toEqual({
			ok: false,
			reason: 'bad_quantity'
		});
	});

	it('adds grants times quantity to the meter an add-on names', () => {
		const pro = of('managed-pro');
		const sum = (id: string, quantity: number) => of('managed-pro', [hold(id, quantity)]);
		const grants = (id: string, quantity: number) => (findAddOn(id)?.grants ?? 0) * quantity;
		expect(sum('extra-site', 2).sites).toBe((pro.sites ?? 0) + grants('extra-site', 2));
		expect(sum('support-hours', 3).supportHoursPerYear).toBe(
			(pro.supportHoursPerYear ?? 0) + grants('support-hours', 3)
		);
		expect(sum('container-hours', 2).containerHours).toBe(
			(pro.containerHours ?? 0) + grants('container-hours', 2)
		);
		expect(sum('mail-sends', 1).mailSends).toBe((pro.mailSends ?? 0) + grants('mail-sends', 1));
		expect(sum('views', 2).views).toBe((pro.views ?? 0) + grants('views', 2));
		expect(sum('writes', 1).writes).toBe((pro.writes ?? 0) + grants('writes', 1));
		expect(sum('storage', 1).storageGb).toBe((pro.storageGb ?? 0) + grants('storage', 1));
		expect(sum('backup-storage', 1).backupGb).toBe(
			(pro.backupGb ?? 0) + grants('backup-storage', 1)
		);
		expect(sum('hostnames', 5).customDomains).toBe(
			(pro.customDomains ?? 0) + grants('hostnames', 5)
		);
		expect(sum('invitees', 1).invitees).toBe((pro.invitees ?? 0) + grants('invitees', 1));
	});

	it('leaves every other figure alone when an add-on adds to one', () => {
		const plain = of('managed-pro');
		const bought = of('managed-pro', [hold('extra-site', 4)]);
		expect(bought).toEqual({
			...plain,
			sites: (plain.sites ?? 0) + 4,
			addOns: [hold('extra-site', 4)]
		});
	});

	it('sums one add-on held twice into one holding', () => {
		const twice = of('managed-pro', [hold('extra-site'), hold('extra-site')]);
		expect(twice.addOns).toEqual([hold('extra-site', 2)]);
		expect(twice.sites).toBe((of('managed-pro').sites ?? 0) + 2);
	});

	it('raises the support level and never lowers it, whatever the order', () => {
		expect(of('managed-free', [hold('support-core')]).support).toBe('core');
		const both = [hold('support-core'), hold('support-business')];
		expect(of('managed-free', both).support).toBe('business');
		expect(of('managed-free', [...both].reverse()).support).toBe('business');
		expect(of('managed-pro', [hold('support-business')]).support).toBe('business');
		expect(of('institution-starter').support).toBe('business');
	});

	it('adds the assurance flag to the standard plan and leaves the figures alone', () => {
		const plain = of('institution-standard');
		const assured = of('institution-standard', [hold('assurance')]);
		expect(plain.assurance).toBe(false);
		expect(assured).toEqual({ ...plain, assurance: true, addOns: [hold('assurance')] });
	});
});

describe('plans on another plane', () => {
	it('gives a managed site under a self plan the figures of Managed Free', () => {
		const free = of(FREE_PLAN_ID);
		for (const id of ['self-hosted', 'self-managed', 'self-managed-plus']) {
			const entitlement = of(id);
			expect(entitlement.managedPlanId, id).toBe(FREE_PLAN_ID);
			expect(entitlement.plane, id).toBe(findPlan(id)?.plane);
			expect(entitlement.sites, id).toBe(free.sites);
			expect(entitlement.views, id).toBe(free.views);
			expect(entitlement.invitees, id).toBe(free.invitees);
			expect(entitlement.customDomains, id).toBe(free.customDomains);
			expect(entitlement.environments, id).toBe(false);
			expect(entitlement.features.customCode, id).toBe(false);
		}
	});

	it('takes pooled figures from the plan itself', () => {
		for (const id of ['self-managed', 'self-managed-plus', 'self-hosted']) {
			const row = findPlan(id) as Plan;
			expect(of(id), id).toMatchObject({
				backupGb: row.backupGb.value,
				containerHours: row.containerHours.value,
				mailSends: row.mailSends.value,
				supportHoursPerYear: row.supportHoursPerYear.value,
				support: row.supportLevel
			});
		}
	});

	it('keeps backups for as long as the plan states, and for Managed Free days when it states none', () => {
		const free = of(FREE_PLAN_ID);
		for (const id of ['self-managed', 'self-managed-plus', 'self-hosted']) {
			const stated = (findPlan(id) as Plan).backupDays.value;
			expect(of(id).backupDays, id).toBe(stated ?? free.backupDays);
		}
	});

	it('sells a self plan only the add-ons that run on its plane', () => {
		const base = of('self-managed-plus');
		const plus = of('self-managed-plus', [hold('support-hours'), hold('container-hours', 2)]);
		expect(plus.supportHoursPerYear).toBe(
			(base.supportHoursPerYear ?? 0) + (findAddOn('support-hours')?.grants ?? 0)
		);
		expect(plus.containerHours).toBe(
			(base.containerHours ?? 0) + 2 * (findAddOn('container-hours')?.grants ?? 0)
		);
		expect(derive('self-managed', [hold('views')])).toEqual({
			ok: false,
			reason: 'add_on_not_offered'
		});
		expect(derive('self-managed-plus', [hold('extra-site')])).toEqual({
			ok: false,
			reason: 'add_on_not_offered'
		});
		expect(derive('self-hosted', [hold('container-hours')])).toEqual({
			ok: false,
			reason: 'add_on_not_offered'
		});
	});

	it('names the plan a managed site runs under', () => {
		expect(of('managed-pro').managedPlanId).toBe('managed-pro');
		expect(of('institution-standard').managedPlanId).toBe('institution-standard');
		expect(managedIsFree(of(FREE_PLAN_ID))).toBe(true);
		expect(managedIsFree(of('self-managed'))).toBe(true);
		expect(managedIsFree(of('managed-pro'))).toBe(false);
		expect(managedIsFree(of('enterprise'))).toBe(false);
	});
});

describe('derived features', () => {
	const plans = LADDER.map((id) => findPlan(id) as Plan);

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
		const standard = of('institution-standard');
		expect(standard.features.ssoSaml).toBe(true);
		expect(canActivate(standard, { ssoBuilt: false })).toEqual({
			ok: false,
			reason: 'sso_not_built'
		});
		const assured = of('institution-standard', [hold('assurance')]);
		expect(canActivate(assured, { ssoBuilt: false }).ok).toBe(false);
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
		expect(check('site.explode', of('managed-pro'), { sitesInOrg: 0 })).toEqual({
			allow: false,
			reason: 'unknown_action'
		});
		const without = { ...of('managed-pro'), dashboard: false };
		expect(check('site.create', without, { sitesInOrg: 0 })).toEqual({
			allow: false,
			reason: 'dashboard_not_included'
		});
	});

	it('allows a site up to the limit and refuses the next one', () => {
		const pro = of('managed-pro');
		expect(check('site.create', pro, { sitesInOrg: 2 })).toEqual({ allow: true });
		expect(check('site.create', pro, { sitesInOrg: 3 })).toEqual({
			allow: false,
			reason: 'site_limit'
		});
	});

	it('raises the limit by the sites an add-on bought', () => {
		const bought = of('managed-pro', [hold('extra-site', 2)]);
		expect(check('site.create', bought, { sitesInOrg: 4 })).toEqual({ allow: true });
		expect(check('site.create', bought, { sitesInOrg: 5 })).toEqual({
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

	it('never caps a site on the customer own Cloudflare account or box', () => {
		for (const id of ['self-hosted', 'self-managed', 'self-managed-plus']) {
			const plane = findPlan(id)?.plane;
			expect(check('site.create', of(id), { sitesInOrg: 500, plane }), id).toEqual({
				allow: true
			});
		}
	});

	it('holds a managed site under a self plan to the free limit', () => {
		const plus = of('self-managed-plus');
		expect(check('site.create', plus, { sitesInOrg: 2, freeSitesOwnedByUser: 2 })).toEqual({
			allow: true
		});
		expect(check('site.create', plus, { sitesInOrg: 3 })).toEqual({
			allow: false,
			reason: 'site_limit'
		});
		expect(check('site.create', plus, { sitesInOrg: 2, freeSitesOwnedByUser: 3 })).toEqual({
			allow: false,
			reason: 'free_limit'
		});
	});

	it('allows a custom Worker on the managed plane only on a plan that includes it', () => {
		const facts = { sitesInOrg: 0, customWorker: true };
		const denied = { allow: false, reason: 'feature_not_included' };
		expect(check('site.create', of(FREE_PLAN_ID), facts)).toEqual(denied);
		expect(check('site.create', of('self-managed-plus'), facts)).toEqual(denied);
		expect(check('site.create', of('managed-pro'), facts)).toEqual({ allow: true });
	});

	it('does not gate a custom Worker on the customer own Cloudflare account or box', () => {
		for (const plane of ['self-managed', 'self-hosted'] as const) {
			const facts = { sitesInOrg: 0, customWorker: true, plane };
			expect(check('site.create', of(FREE_PLAN_ID), facts), plane).toEqual({ allow: true });
		}
	});

	it('answers each feature flag from the entitlement and denies a flag the plan does not state', () => {
		const pro = of('managed-pro');
		for (const feature of FEATURES) {
			expect(isFeature(feature)).toBe(true);
			expect(check(feature, pro, { sitesInOrg: 0 }).allow, feature).toBe(
				pro.features[feature]
			);
		}
		expect(check('customCode', pro, { sitesInOrg: 0 })).toEqual({ allow: true });
		expect(check('strata', pro, { sitesInOrg: 0 })).toEqual({ allow: true });
		expect(check('ssoSaml', pro, { sitesInOrg: 0 })).toEqual({
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
		expect(entitlementKeys(of('managed-pro'))).toEqual(['environments', 'previews']);
		expect(entitlementKeys(of('institution-standard'))).toEqual(['sso']);
		expect(entitlementKeys(of('self-managed'))).toEqual([]);
		expect(entitlementKeys({ ...of('managed-pro'), dashboard: false })).toEqual([]);
	});

	it('turns only known figures into limits', () => {
		const pro = of('managed-pro');
		expect(siteLimits(pro)).toEqual({
			views: pro.views,
			customDomains: pro.customDomains,
			backupDays: pro.backupDays
		});
		expect(siteLimits(of('managed-pro', [hold('views', 2)])).views).toBe(
			(pro.views ?? 0) + 2 * (findAddOn('views')?.grants ?? 0)
		);
		expect(siteLimits(of('enterprise'))).toEqual({});
	});
});
