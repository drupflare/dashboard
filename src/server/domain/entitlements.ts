import {
	SUPPORT_LEVELS,
	addOnOffered,
	findAddOn,
	findPlan,
	type MeterId,
	type Plan,
	type Plane,
	type SupportLevel
} from '../../shared/plans';

export const FEATURES = [
	'privateSites',
	'rollback',
	'upgrade',
	'customDomains',
	'customCode',
	'strata',
	'ssoSaml',
	'ssoOidc'
] as const;
export type Feature = (typeof FEATURES)[number];

export const FREE_PLAN_ID = 'managed-free';

export const ENTITLEMENT_STATES = ['pending', 'blocked', 'activated', 'revoked'] as const;
export type EntitlementState = (typeof ENTITLEMENT_STATES)[number];

export interface AddOnHolding {
	id: string;
	quantity: number;
}

// a null limit is unknown or negotiated, and unknown denies. Site figures (sites, views, storage,
// writes, invitees, domains, environments, features) are those of the managed plan, or of Managed
// Free when the plan is on another plane, because self-managed and self-hosted sites run on the
// customer's own resources. Pooled figures (support, backups, mail, container hours) are those of
// the plan itself. Backup days are the managed plan's, or the plan's own on another plane.
export interface Entitlement {
	planId: string;
	// the plan a managed site runs under
	managedPlanId: string;
	plane: Plane;
	addOns: readonly AddOnHolding[];
	dashboard: boolean;
	sites: number | null;
	views: number | null;
	viewsPooled: boolean | null;
	storageGb: number | null;
	writes: number | null;
	backupGb: number | null;
	mailSends: number | null;
	containerHours: number | null;
	invitees: number | null;
	nodes: number | null;
	support: SupportLevel;
	supportHoursPerYear: number | null;
	assurance: boolean;
	environments: boolean;
	pilots: boolean;
	customDomains: number | null;
	backupDays: number | null;
	features: Record<Feature, boolean>;
}

export type EntitlementError =
	| 'unknown_plan'
	| 'plan_disabled'
	| 'unknown_add_on'
	| 'add_on_unavailable'
	| 'add_on_not_offered'
	| 'bad_quantity';

type Result<T> = ({ ok: true } & T) | { ok: false; reason: EntitlementError };

const fail = (reason: EntitlementError) => ({ ok: false as const, reason });

const num = (figure: { value: number | null }) => figure.value;

type Counted =
	| 'sites'
	| 'views'
	| 'storageGb'
	| 'writes'
	| 'backupGb'
	| 'mailSends'
	| 'containerHours'
	| 'invitees'
	| 'customDomains'
	| 'supportHoursPerYear';

// the entitlement field each add-on meter adds to; the other meters set a flag or a level
const COUNTED: Partial<Record<MeterId, Counted>> = {
	sites: 'sites',
	views: 'views',
	storage: 'storageGb',
	writes: 'writes',
	'backup-storage': 'backupGb',
	'mail-sends': 'mailSends',
	'container-hours': 'containerHours',
	invitees: 'invitees',
	hostnames: 'customDomains',
	'support-hours': 'supportHoursPerYear'
};

const missingFree = (): never => {
	throw new Error(`the catalogue has no ${FREE_PLAN_ID} plan`);
};
const FREE_PLAN: Plan = findPlan(FREE_PLAN_ID) ?? missingFree();

function featuresOf(site: Plan, own: Plan): Record<Feature, boolean> {
	return {
		privateSites: site.privateSites === true,
		rollback: site.rollback === true,
		upgrade: site.upgrade === true,
		customDomains: (num(site.customDomains) ?? 0) > 0,
		customCode: site.customCode === true,
		strata: site.strata === true,
		ssoSaml: own.ssoSaml === true,
		ssoOidc: own.ssoOidc === true
	};
}

const grow = (base: number | null, by: number) => (base === null ? null : base + by);

// an add-on held twice is one holding with the quantities summed
function merged(holdings: readonly AddOnHolding[]): AddOnHolding[] {
	const byId = new Map<string, number>();
	for (const { id, quantity } of holdings) byId.set(id, (byId.get(id) ?? 0) + quantity);
	return [...byId].map(([id, quantity]) => ({ id, quantity }));
}

// a null base stays null, so an unknown or negotiated figure never turns into a number
export function derive(
	planId: string,
	holdings: readonly AddOnHolding[] = []
): Result<{ entitlement: Entitlement }> {
	const plan = findPlan(planId);
	if (!plan) return fail('unknown_plan');
	if (plan.disabled) return fail('plan_disabled');
	const site = plan.plane === 'managed' ? plan : FREE_PLAN;
	const features = featuresOf(site, plan);
	const counts: Record<Counted, number | null> = {
		sites: num(site.sites),
		views: num(site.views),
		storageGb: num(site.storageGb),
		writes: num(site.writes),
		backupGb: num(plan.backupGb),
		mailSends: num(plan.mailSends),
		containerHours: num(plan.containerHours),
		invitees: num(site.invitees),
		customDomains: num(site.customDomains),
		supportHoursPerYear: num(plan.supportHoursPerYear)
	};
	let support = plan.supportLevel;
	let assurance = false;
	const held = merged(holdings);
	for (const { id, quantity } of held) {
		if (!Number.isInteger(quantity) || quantity < 1) return fail('bad_quantity');
		const addOn = findAddOn(id);
		if (!addOn) return fail('unknown_add_on');
		if (!addOn.available) return fail('add_on_unavailable');
		if (!addOnOffered(addOn, plan)) return fail('add_on_not_offered');
		const field = COUNTED[addOn.meter];
		if (field) counts[field] = grow(counts[field], addOn.grants * quantity);
		if (addOn.supportLevel !== null) {
			support =
				SUPPORT_LEVELS.indexOf(addOn.supportLevel) > SUPPORT_LEVELS.indexOf(support)
					? addOn.supportLevel
					: support;
		}
		if (addOn.meter === 'assurance') assurance = true;
		features.ssoSaml ||= addOn.ssoSaml;
		features.ssoOidc ||= addOn.ssoOidc;
	}
	// retention goes with the pooled backup storage on a self plan, which falls back to Managed Free
	const ownDays = plan.plane === 'managed' ? null : num(plan.backupDays);
	const backupDays = ownDays ?? num(site.backupDays);
	return {
		ok: true,
		entitlement: {
			planId: plan.id,
			managedPlanId: site.id,
			plane: plan.plane,
			addOns: held,
			dashboard: plan.dashboard,
			...counts,
			viewsPooled: site.viewsPooled,
			nodes: num(plan.nodes),
			support,
			assurance,
			environments: site.staging === true,
			pilots: plan.pilots,
			backupDays,
			features
		}
	};
}

export interface SsoBuilt {
	oidc: boolean;
	saml: boolean;
}

// each protocol is gated on its own feature and its own built flag
export function canActivate(
	entitlement: Entitlement,
	flags: { ssoBuilt: SsoBuilt }
): { ok: true } | { ok: false; reason: 'sso_not_built' } {
	const { ssoSaml, ssoOidc } = entitlement.features;
	if ((ssoSaml && !flags.ssoBuilt.saml) || (ssoOidc && !flags.ssoBuilt.oidc)) {
		return { ok: false, reason: 'sso_not_built' };
	}
	return { ok: true };
}

export function managedIsFree(entitlement: Entitlement): boolean {
	return entitlement.managedPlanId === FREE_PLAN_ID;
}

export interface CheckFacts {
	// sites on the plane of the site being created
	sitesInOrg: number;
	// the plane of the site being created; absent means managed
	plane?: Plane;
	// sites on the free plan across every organisation the user owns
	freeSitesOwnedByUser?: number;
	customWorker?: boolean;
	// a platform admin is not held to the site count of a plan
	platformAdmin?: boolean;
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

// a custom Worker shares our namespace only on the managed plane, so only there does it need a plan
function allowCustom(entitlement: Entitlement, facts: CheckFacts): CheckResult {
	const needsPlan = (facts.plane ?? 'managed') === 'managed' && facts.customWorker === true;
	return needsPlan && !entitlement.features.customCode
		? deny('feature_not_included')
		: { allow: true };
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
		const managed = (facts.plane ?? 'managed') === 'managed';
		if (managed && facts.platformAdmin !== true) {
			const { sites } = entitlement;
			if (sites === null) return deny('unknown_limit');
			if (facts.sitesInOrg >= sites) return deny('site_limit');
			if (
				managedIsFree(entitlement) &&
				(facts.freeSitesOwnedByUser ?? facts.sitesInOrg) >= sites
			) {
				return deny('free_limit');
			}
		}
		return allowCustom(entitlement, facts);
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
	if (entitlement.features.ssoSaml || entitlement.features.ssoOidc) keys.push('sso');
	if (entitlement.environments) keys.push('environments', 'previews');
	if (entitlement.pilots) keys.push('pilots');
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
