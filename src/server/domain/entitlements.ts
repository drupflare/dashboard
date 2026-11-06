import { findPlan, type Plan, type SupportLevel } from '../../shared/plans';

export const FEATURES = [
	'privateSites',
	'rollback',
	'upgrade',
	'customDomains',
	'customCode',
	'strata',
	'ssoSaml'
] as const;
export type Feature = (typeof FEATURES)[number];

export const FREE_PLAN_ID = 'managed-free';
export const ASSURANCE_BASE_ID = 'institution-standard';

export const ENTITLEMENT_STATES = ['pending', 'blocked', 'activated', 'revoked'] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

// a null limit is unknown or negotiated, and unknown denies
export interface Entitlement {
	planId: string;
	addOns: readonly string[];
	dashboard: boolean;
	sites: number | null;
	views: number | null;
	viewsPooled: boolean | null;
	nodes: number | null;
	support: SupportLevel;
	supportHours: number | null;
	assurance: boolean;
	environments: boolean;
	customDomains: number | null;
	backupDays: number | null;
	features: Record<Feature, boolean>;
}

export type EntitlementError =
	'unknown_plan' | 'plan_disabled' | 'not_an_add_on' | 'add_on_needs_standard';

type Result<T> = ({ ok: true } & T) | { ok: false; reason: EntitlementError };

const fail = (reason: EntitlementError) => ({ ok: false as const, reason });

const num = (figure: { value: number | null }) => figure.value;

function featuresOf(plan: Plan): Record<Feature, boolean> {
	return {
		privateSites: plan.privateSites === true,
		rollback: plan.rollback === true,
		upgrade: plan.upgrade === true,
		customDomains: (num(plan.customDomains) ?? 0) > 0,
		customCode: plan.customCode === true,
		strata: plan.strata === true,
		ssoSaml: plan.ssoSaml === true
	};
}

export function derive(
	planId: string,
	addOnIds: readonly string[] = []
): Result<{ entitlement: Entitlement }> {
	const plan = findPlan(planId);
	if (!plan) return fail('unknown_plan');
	if (plan.disabled) return fail('plan_disabled');
	const features = featuresOf(plan);
	let assurance = false;
	for (const id of addOnIds) {
		const addOn = findPlan(id);
		if (!addOn) return fail('unknown_plan');
		if (addOn.disabled) return fail('plan_disabled');
		if (addOn.kind !== 'add-on') return fail('not_an_add_on');
		if (plan.id !== ASSURANCE_BASE_ID) return fail('add_on_needs_standard');
		assurance = true;
		features.ssoSaml ||= addOn.ssoSaml === true;
	}
	return {
		ok: true,
		entitlement: {
			planId: plan.id,
			addOns: [...addOnIds],
			dashboard: plan.dashboard,
			sites: num(plan.sites),
			views: num(plan.views),
			viewsPooled: plan.viewsPooled,
			nodes: num(plan.nodes),
			support: plan.supportLevel,
			supportHours: num(plan.supportHours),
			assurance,
			environments: plan.staging === true,
			customDomains: num(plan.customDomains),
			backupDays: num(plan.backupDays),
			features
		}
	};
}

// an entitlement with single sign-on stays blocked until the feature has shipped
export function canActivate(
	entitlement: Entitlement,
	flags: { ssoBuilt: boolean }
): { ok: true } | { ok: false; reason: 'sso_not_built' } {
	if (entitlement.features.ssoSaml && !flags.ssoBuilt) {
		return { ok: false, reason: 'sso_not_built' };
	}
	return { ok: true };
}

export interface CheckFacts {
	sitesInOrg: number;
	// sites on the free plan across every organisation the user owns
	freeSitesOwnedByUser?: number;
	customWorker?: boolean;
}

export type CheckDenial =
	| 'no_entitlement'
	| 'unknown_action'
	| 'dashboard_not_included'
	| 'unknown_limit'
	| 'site_limit'
	| 'free_limit'
	| 'feature_not_included';

export type CheckResult = { allow: true } | { allow: false; reason: CheckDenial };

const deny = (reason: CheckDenial): CheckResult => ({ allow: false, reason });

export function isFeature(value: string): value is Feature {
	return (FEATURES as readonly string[]).includes(value);
}

// default deny: an action this function does not name is refused
export function check(
	action: string,
	entitlement: Entitlement | null,
	facts: CheckFacts
): CheckResult {
	if (entitlement === null) return deny('no_entitlement');
	if (!entitlement.dashboard) return deny('dashboard_not_included');
	if (action === 'site.create') {
		if (entitlement.sites === null) return deny('unknown_limit');
		if (facts.sitesInOrg >= entitlement.sites) return deny('site_limit');
		if (
			entitlement.planId === FREE_PLAN_ID &&
			(facts.freeSitesOwnedByUser ?? facts.sitesInOrg) >= entitlement.sites
		) {
			return deny('free_limit');
		}
		if (facts.customWorker === true && !entitlement.features.customCode) {
			return deny('feature_not_included');
		}
		return { allow: true };
	}
	if (isFeature(action)) {
		return entitlement.features[action] ? { allow: true } : deny('feature_not_included');
	}
	return deny('unknown_action');
}

// the strings the authorizer reads from facts.entitlements
export function entitlementKeys(entitlement: Entitlement | null): string[] {
	if (entitlement === null || !entitlement.dashboard) return [];
	const keys: string[] = [];
	if (entitlement.features.ssoSaml) keys.push('sso');
	if (entitlement.environments) keys.push('environments');
	return keys;
}

// only known numbers become limits, so an unknown figure never turns into zero
export function siteLimits(entitlement: Entitlement): Record<string, number> {
	const limits: Record<string, number> = {};
	if (entitlement.views !== null) limits.views = entitlement.views;
	if (entitlement.customDomains !== null) limits.customDomains = entitlement.customDomains;
	if (entitlement.backupDays !== null) limits.backupDays = entitlement.backupDays;
	return limits;
}
