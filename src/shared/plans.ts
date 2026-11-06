import { z } from 'zod';

export const FIGURE_LABELS = ['published', 'measured', 'derived', 'assumption'] as const;

export const figureSchema = z.union([
	z.object({ value: z.number(), label: z.enum(FIGURE_LABELS), source: z.string().min(1) }),
	z.object({ value: z.null(), source: z.string().min(1) })
]);

export const reviewSchema = z
	.object({ reviewed: z.boolean(), reviewNote: z.string().min(1).nullable() })
	.refine((review) => !review.reviewed || review.reviewNote !== null, {
		message: 'a reviewed catalogue needs a review note'
	});

export const PLAN_REVIEW = reviewSchema.parse({ reviewed: false, reviewNote: null });

export function priceVisible(review: z.infer<typeof reviewSchema> = PLAN_REVIEW): boolean {
	return review.reviewed;
}

const PLAN_KINDS = [
	'self-hosted',
	'self-managed',
	'managed',
	'institution',
	'add-on',
	'enterprise',
	'compute'
] as const;

export const SUPPORT_LEVELS = ['community', 'core', 'business', 'critical'] as const;
export type SupportLevel = (typeof SUPPORT_LEVELS)[number];

const planSchema = z.object({
	unreviewed: z.boolean(),
	disabled: z.boolean(),
	dashboard: z.boolean(),
	supportLevel: z.enum(SUPPORT_LEVELS),
	nodes: figureSchema,
	privateSites: z.boolean().nullable(),
	rollback: z.boolean().nullable(),
	upgrade: z.boolean().nullable(),
	customCode: z.boolean().nullable(),
	strata: z.boolean().nullable(),
	id: z.string().min(1),
	name: z.string().min(1),
	kind: z.enum(PLAN_KINDS),
	lookupKey: z.string().min(1),
	monthly: figureSchema,
	annual: figureSchema,
	sites: figureSchema,
	views: figureSchema,
	viewsPooled: z.boolean().nullable(),
	support: z.string().min(1),
	supportHours: figureSchema,
	customDomains: figureSchema,
	backupDays: figureSchema,
	staging: z.boolean().nullable(),
	ssoSaml: z.boolean().nullable(),
	source: z.string().min(1)
});

export type Plan = z.infer<typeof planSchema>;

const derived = (value: number, source: string) => ({ value, label: 'derived', source });
const assumed = (value: number, source: string) => ({ value, label: 'assumption', source });
const unknown = (source: string) => ({ value: null, source });

// lookup keys are chosen here, not read from stripe; stripe:sync creates the prices
const ROWS = [
	{
		id: 'self-hosted',
		name: 'Self-hosted (bastion)',
		kind: 'self-hosted',
		lookupKey: 'drupflare_self_hosted',
		monthly: derived(0, 'roadmap:257'),
		annual: derived(0, 'roadmap:257'),
		sites: unknown('roadmap:257 says unlimited, which is not a count'),
		views: unknown('roadmap:257 says not metered'),
		viewsPooled: null,
		support: 'Community',
		supportHours: unknown('roadmap:257 lists no hours'),
		customDomains: unknown('not a managed plan'),
		backupDays: unknown('not stated for this plan'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap:257'
	},
	{
		id: 'self-managed',
		name: 'Self-managed',
		kind: 'self-managed',
		lookupKey: 'drupflare_self_managed',
		monthly: derived(0, 'roadmap:258'),
		annual: derived(0, 'roadmap:258'),
		sites: unknown('roadmap:258 says unlimited, fair use'),
		views: unknown('roadmap:258 says views sit on the customer plan'),
		viewsPooled: null,
		support: 'Community',
		supportHours: unknown('roadmap:258 lists no hours'),
		customDomains: unknown('not a managed plan'),
		backupDays: unknown('not stated for this plan'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap:258'
	},
	{
		id: 'self-managed-dashboard',
		name: 'Self-managed with the dashboard',
		kind: 'self-managed',
		lookupKey: 'drupflare_self_managed_dashboard',
		monthly: unknown('roadmap:274 records no price; it stays below one Workers Paid plan'),
		annual: unknown('roadmap:274 records no price'),
		sites: unknown('roadmap:274 gives no site count'),
		views: unknown('roadmap:258 says views sit on the customer plan'),
		viewsPooled: null,
		support: 'Community',
		supportHours: unknown('roadmap:274 lists no hours'),
		customDomains: unknown('roadmap:274 gives no custom domain count'),
		backupDays: unknown('not stated for this plan'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap:274'
	},
	{
		id: 'managed-free',
		name: 'Managed Free',
		kind: 'managed',
		lookupKey: 'drupflare_managed_free',
		monthly: derived(0, 'roadmap:259'),
		annual: derived(0, 'roadmap:259'),
		sites: assumed(3, 'roadmap:259 "3 on *.drupflare.app"'),
		views: assumed(100000, 'roadmap:259 "100,000, pooled"'),
		viewsPooled: true,
		support: 'Community',
		supportHours: unknown('roadmap:259 lists no hours'),
		customDomains: assumed(0, 'roadmap:270 first value, mapped to Free by order'),
		backupDays: unknown('roadmap:270 gives 7 then 30 without tiers'),
		staging: false,
		ssoSaml: null,
		source: 'roadmap:259'
	},
	{
		id: 'managed-site',
		name: 'Managed Site',
		kind: 'managed',
		lookupKey: 'drupflare_managed_site',
		monthly: derived(18, 'roadmap:260; roadmap:1034'),
		annual: derived(180, 'roadmap:260; roadmap:1034'),
		sites: assumed(1, 'roadmap:260'),
		views: assumed(500000, 'roadmap:260'),
		viewsPooled: false,
		support: 'Core',
		supportHours: unknown('roadmap:260 lists no hours'),
		customDomains: assumed(3, 'roadmap:270 second value, mapped by order'),
		backupDays: unknown('roadmap:270 gives 7 then 30 without tiers'),
		staging: true,
		ssoSaml: null,
		source: 'roadmap:260'
	},
	{
		id: 'managed-studio',
		name: 'Managed Studio',
		kind: 'managed',
		lookupKey: 'drupflare_managed_studio',
		monthly: derived(59, 'roadmap:261; roadmap:1034'),
		annual: derived(588, 'roadmap:261; roadmap:1034'),
		sites: assumed(5, 'roadmap:261'),
		views: assumed(2000000, 'roadmap:261'),
		viewsPooled: true,
		support: 'Core',
		supportHours: unknown('roadmap:261 lists no hours'),
		customDomains: assumed(10, 'roadmap:270 third value, mapped by order'),
		backupDays: unknown('roadmap:270 gives 7 then 30 without tiers'),
		staging: true,
		ssoSaml: null,
		source: 'roadmap:261'
	},
	{
		id: 'managed-agency',
		name: 'Managed Agency',
		kind: 'managed',
		lookupKey: 'drupflare_managed_agency',
		monthly: derived(449, 'roadmap:262; roadmap:1034'),
		annual: derived(4500, 'roadmap:262 "$375 a month" on annual billing, times 12'),
		sites: assumed(50, 'roadmap:262 "50, blocks of 50 at $399"; block price not modelled'),
		views: assumed(20000000, 'roadmap:262 "20 million, pooled"'),
		viewsPooled: true,
		support: 'Core and 2 hours',
		supportHours: assumed(2, 'roadmap:262'),
		customDomains: assumed(100, 'roadmap:270 fourth value, mapped by order'),
		backupDays: unknown('roadmap:270 gives 7 then 30 without tiers'),
		staging: true,
		ssoSaml: null,
		source: 'roadmap:262'
	},
	{
		id: 'institution-starter',
		name: 'Institution Starter',
		kind: 'institution',
		lookupKey: 'drupflare_institution_starter',
		monthly: derived(1249, 'roadmap:263'),
		annual: derived(14988, 'roadmap:263 "annual only"'),
		sites: assumed(75, 'roadmap:263'),
		views: assumed(15000000, 'roadmap:263'),
		viewsPooled: null,
		support: 'Business and 5 hours',
		supportHours: assumed(5, 'roadmap:263'),
		customDomains: unknown('roadmap:263 gives no custom domain count'),
		backupDays: unknown('roadmap:263 gives no backup days'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap:263'
	},
	{
		id: 'institution-standard',
		name: 'Institution Standard',
		kind: 'institution',
		lookupKey: 'drupflare_institution_standard',
		monthly: derived(3999, 'roadmap:264'),
		annual: derived(47988, 'roadmap:264 "annual prepaid"'),
		sites: assumed(250, 'roadmap:264; block price not modelled'),
		views: assumed(60000000, 'roadmap:264'),
		viewsPooled: null,
		support: 'Business and 16 hours',
		supportHours: assumed(16, 'roadmap:264'),
		customDomains: unknown('roadmap:264 gives no custom domain count'),
		backupDays: unknown('roadmap:264 gives no backup days'),
		staging: null,
		ssoSaml: true,
		source: 'roadmap:264; roadmap:271'
	},
	{
		id: 'assurance',
		name: 'Assurance (add-on to Standard)',
		kind: 'add-on',
		lookupKey: 'drupflare_assurance',
		monthly: derived(1500, 'roadmap:265 "+$1,500"'),
		annual: derived(18000, 'roadmap:265 "+$18,000"'),
		sites: unknown('roadmap:265 says same as Standard'),
		views: unknown('roadmap:265 says same as Standard'),
		viewsPooled: null,
		support: '1-hour critical in business hours',
		supportHours: unknown('roadmap:265 lists no hours'),
		customDomains: unknown('roadmap:265 says same as Standard'),
		backupDays: unknown('roadmap:265 says same as Standard'),
		staging: null,
		ssoSaml: true,
		source: 'roadmap:265; roadmap:271'
	},
	{
		id: 'enterprise',
		name: 'Enterprise',
		kind: 'enterprise',
		lookupKey: 'drupflare_enterprise',
		monthly: derived(5499, 'roadmap:266 "from $5,499"'),
		annual: unknown('roadmap:266 says contract'),
		sites: unknown('roadmap:266 says negotiated'),
		views: unknown('roadmap:266 says negotiated'),
		viewsPooled: null,
		support: 'Critical when staffed',
		supportHours: unknown('roadmap:266 lists no hours'),
		customDomains: unknown('roadmap:266 says negotiated'),
		backupDays: unknown('roadmap:266 says negotiated'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap:266'
	},
	{
		id: 'gmux-compute',
		name: 'gmux compute',
		kind: 'compute',
		lookupKey: 'drupflare_gmux_compute',
		monthly: derived(50, 'roadmap:267 "about $50 per 4 vCPU 16 GB"'),
		annual: derived(604, 'roadmap:267'),
		sites: unknown('roadmap:267 says n/a'),
		views: unknown('roadmap:267 says n/a'),
		viewsPooled: null,
		support: 'by support plan',
		supportHours: unknown('roadmap:267 lists no hours'),
		customDomains: unknown('roadmap:267 says n/a'),
		backupDays: unknown('roadmap:267 says n/a'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap:267'
	}
];

const DEFAULTS = {
	unreviewed: true,
	disabled: false,
	dashboard: true,
	supportLevel: 'community',
	nodes: unknown('the roadmap states instances only for the hosted dashboard link'),
	privateSites: null,
	rollback: null,
	upgrade: null,
	customCode: null,
	strata: null
};

// a flag the roadmap does not state stays null, and null denies
const MANAGED_PAID = { privateSites: true, customCode: true, supportLevel: 'core' };

const OVERRIDES: Record<string, Record<string, unknown>> = {
	'self-hosted': { dashboard: false },
	'self-managed': { dashboard: false },
	'managed-free': { privateSites: true, customCode: false, strata: false },
	'managed-site': MANAGED_PAID,
	'managed-studio': MANAGED_PAID,
	'managed-agency': MANAGED_PAID,
	'institution-starter': { supportLevel: 'business', customCode: true },
	'institution-standard': { supportLevel: 'business', customCode: true },
	assurance: { supportLevel: 'business' },
	enterprise: { supportLevel: 'critical', customCode: true },
	'gmux-compute': { disabled: true, dashboard: false }
};

export const PLANS: readonly Plan[] = z
	.array(planSchema)
	.parse(ROWS.map((row) => ({ ...DEFAULTS, ...row, ...OVERRIDES[row.id] })));

export interface PlanViewer {
	admin: boolean;
}

export function planPricesVisible(
	plan: Plan,
	viewer: PlanViewer,
	review: z.infer<typeof reviewSchema> = PLAN_REVIEW
): boolean {
	return viewer.admin || (priceVisible(review) && !plan.unreviewed && !plan.disabled);
}

// the price keys are absent, never null, while a price is hidden
export function describePlan(
	plan: Plan,
	viewer: PlanViewer,
	review: z.infer<typeof reviewSchema> = PLAN_REVIEW
) {
	const shown = {
		id: plan.id,
		name: plan.name,
		kind: plan.kind,
		lookupKey: plan.lookupKey,
		sites: plan.sites.value,
		views: plan.views.value,
		support: plan.support,
		disabled: plan.disabled
	};
	if (!planPricesVisible(plan, viewer, review)) return shown;
	return {
		...shown,
		monthly: plan.monthly.value,
		annual: plan.annual.value,
		unreviewed: plan.unreviewed
	};
}

export function findPlan(id: string): Plan | undefined {
	return PLANS.find((plan) => plan.id === id);
}

export const INTERVALS = ['month', 'year'] as const;
export type Interval = (typeof INTERVALS)[number];

// the stripe price lookup key: one product per plan, one price per interval
export function priceLookupKey(plan: Plan, interval: Interval): string {
	return `${plan.lookupKey}_${interval === 'month' ? 'monthly' : 'annual'}`;
}

export function planFromPriceKey(key: string): { plan: Plan; interval: Interval } | undefined {
	for (const plan of PLANS) {
		for (const interval of INTERVALS) {
			if (priceLookupKey(plan, interval) === key) return { plan, interval };
		}
	}
	return undefined;
}

export function intervalPrice(plan: Plan, interval: Interval): number | null {
	return (interval === 'month' ? plan.monthly : plan.annual).value;
}
