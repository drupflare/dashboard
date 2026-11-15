import { z } from 'zod';

export const FIGURE_LABELS = ['published', 'measured', 'derived', 'assumption'] as const;

const figureSource = z.string().min(1);

export const figureSchema = z.union([
	z.object({ value: z.number(), label: z.enum(FIGURE_LABELS), source: figureSource }),
	z.object({ value: z.null(), unlimited: z.literal(true), source: figureSource }),
	z.object({ value: z.null(), source: figureSource })
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

export const PLANES = ['self-hosted', 'self-managed', 'managed'] as const;
export type Plane = (typeof PLANES)[number];

const PLAN_KINDS = ['self-hosted', 'self-managed', 'managed', 'institution', 'enterprise'] as const;

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
	plane: z.enum(PLANES),
	lookupKey: z.string().min(1),
	monthly: figureSchema,
	annual: figureSchema,
	sites: figureSchema,
	views: figureSchema,
	viewsPooled: z.boolean().nullable(),
	storageGb: figureSchema,
	writes: figureSchema,
	backupGb: figureSchema,
	mailSends: figureSchema,
	containerHours: figureSchema,
	invitees: figureSchema,
	support: z.string().min(1),
	supportHoursPerYear: figureSchema,
	customDomains: figureSchema,
	backupDays: figureSchema,
	staging: z.boolean().nullable(),
	ssoSaml: z.boolean().nullable(),
	source: z.string().min(1)
});

export type Plan = z.infer<typeof planSchema>;

const derived = (value: number, source: string) => ({ value, label: 'derived', source });
const assumed = (value: number, source: string) => ({ value, label: 'assumption', source });
const published = (value: number, source: string) => ({ value, label: 'published', source });
const unknown = (source: string) => ({ value: null, source });
const unlimited = (source: string) => ({ value: null, unlimited: true, source });
const unstated = unknown('not stated for this plan');

const DECISION = 'owner decision 2026-11-14';
const OWN_CARD = 'billed to the customer on their own Cloudflare account';
const NO_HOURS =
	'the price cannot carry paid hours at the $62.50 loaded rate; hours are the Support Hours add-on';

// lookup keys are chosen here, not read from stripe; stripe:sync creates the prices
const ROWS = [
	{
		id: 'self-hosted',
		name: 'Self-Hosted',
		kind: 'self-hosted',
		plane: 'self-hosted',
		lookupKey: 'drupflare_self_hosted',
		monthly: derived(0, `${DECISION}; free forever, nothing charged for management or linking`),
		annual: derived(0, DECISION),
		sites: unlimited(DECISION),
		views: unlimited('not metered, the box serves its own traffic'),
		viewsPooled: null,
		storageGb: unlimited('the customer owns the disks'),
		writes: unlimited('the customer owns the database'),
		backupGb: derived(0, `${DECISION}; backup space on our infrastructure is an add-on`),
		mailSends: derived(0, `${DECISION}; email is an add-on`),
		containerHours: derived(0, 'a box builds on its own machine'),
		invitees: unstated,
		support: 'Community',
		supportHoursPerYear: derived(0, DECISION),
		customDomains: unknown('the customer owns the zone'),
		backupDays: unknown('the customer runs the backups'),
		staging: null,
		ssoSaml: null,
		source: DECISION
	},
	{
		id: 'self-managed',
		name: 'Self-Managed Free',
		kind: 'self-managed',
		plane: 'self-managed',
		lookupKey: 'drupflare_self_managed',
		monthly: derived(0, DECISION),
		annual: derived(0, DECISION),
		sites: unlimited(`${DECISION}; the resources are ${OWN_CARD}`),
		views: unknown(`views are ${OWN_CARD}`),
		viewsPooled: null,
		storageGb: unknown(`storage is ${OWN_CARD}`),
		writes: unknown(`writes are ${OWN_CARD}`),
		backupGb: assumed(1, 'the managed free allowance, so a restore point can exist'),
		mailSends: derived(0, 'email is an add-on'),
		containerHours: assumed(
			2,
			'builds run on our Containers when the account has no paid plan for them'
		),
		invitees: unknown('the customer owns the access gate on their account'),
		support: 'Community',
		supportHoursPerYear: derived(0, DECISION),
		customDomains: unknown('the customer owns the zone'),
		backupDays: assumed(7, 'the managed free allowance'),
		staging: null,
		ssoSaml: null,
		source: DECISION
	},
	{
		id: 'self-managed-plus',
		name: 'Self-Managed Plus',
		kind: 'self-managed',
		plane: 'self-managed',
		lookupKey: 'drupflare_self_managed_plus',
		monthly: assumed(
			5,
			'cost plus: the plan costs us about $2 with every allowance used; survey floor Coolify Cloud and Workers $5, Dokploy $4.50'
		),
		annual: derived(50, 'ten months, the roadmap annual convention'),
		sites: unlimited(`${DECISION}; the resources are ${OWN_CARD}`),
		views: unknown(`views are ${OWN_CARD}`),
		viewsPooled: null,
		storageGb: unknown(`storage is ${OWN_CARD}`),
		writes: unknown(`writes are ${OWN_CARD}`),
		backupGb: assumed(50, 'sized by the margin script at the Plus price'),
		mailSends: assumed(
			1000,
			'sized by the margin script at the Plus price, the largest thousand inside the target share'
		),
		containerHours: assumed(10, 'sized by the margin script at the Plus price'),
		invitees: unknown('the customer owns the access gate on their account'),
		support: 'Core',
		supportHoursPerYear: derived(0, NO_HOURS),
		customDomains: unknown('the customer owns the zone'),
		backupDays: assumed(30, 'the managed paid allowance'),
		staging: null,
		ssoSaml: null,
		source: DECISION
	},
	{
		id: 'managed-free',
		name: 'Managed Free',
		kind: 'managed',
		plane: 'managed',
		lookupKey: 'drupflare_managed_free',
		monthly: derived(0, 'roadmap, The Plans'),
		annual: derived(0, 'roadmap, The Plans'),
		sites: derived(3, `${DECISION}; the free ceiling`),
		views: assumed(100000, 'roadmap, The Plans "100,000, pooled"'),
		viewsPooled: true,
		storageGb: assumed(1, 'roadmap, The Plans, storage 1 GB'),
		writes: assumed(500000, 'sized by the margin script at the free cost ceiling'),
		backupGb: assumed(1, 'roadmap, The Plans, storage 1 GB'),
		mailSends: derived(0, 'email is an add-on'),
		containerHours: assumed(0.5, 'about 5 jobs a month at 180 seconds, roadmap, Containers'),
		invitees: assumed(5, 'roadmap, The Plans, 5 by email code'),
		support: 'Community',
		supportHoursPerYear: derived(0, 'roadmap, The Plans lists no hours'),
		customDomains: derived(0, 'roadmap, The Plans, first value'),
		backupDays: assumed(7, 'roadmap, The Plans, 7 days'),
		staging: false,
		ssoSaml: null,
		source: `${DECISION}; roadmap, The Plans`
	},
	{
		id: 'managed-pro',
		name: 'Managed Pro',
		kind: 'managed',
		plane: 'managed',
		lookupKey: 'drupflare_managed_pro',
		monthly: assumed(
			9,
			'cost plus: about twice the plan cost with every allowance used, $3 a site against the $1 floor; survey first paid tiers Netlify $9, Ploi $10'
		),
		annual: derived(90, 'ten months, the roadmap annual convention'),
		sites: assumed(3, 'the free ceiling; more sites are the extra-site add-on'),
		views: assumed(1000000, 'between Site 500,000 and Studio 2 million, roadmap, The Plans'),
		viewsPooled: true,
		storageGb: assumed(5, 'ten times the free plan'),
		writes: assumed(1000000, 'twice the free plan'),
		backupGb: assumed(5, 'five times the free plan'),
		mailSends: assumed(1000, 'inside the 3,000 a month Cloudflare includes per account'),
		containerHours: assumed(1, 'two times the free plan, about 10 jobs a month'),
		invitees: assumed(100, 'roadmap, The Plans, Studio 100'),
		support: 'Core',
		supportHoursPerYear: derived(0, NO_HOURS),
		customDomains: assumed(10, 'roadmap, The Plans, Studio 10'),
		backupDays: assumed(30, 'roadmap, The Plans, 30 days'),
		staging: true,
		ssoSaml: null,
		source: DECISION
	},
	{
		id: 'managed-agency',
		name: 'Managed Agency',
		kind: 'managed',
		plane: 'managed',
		lookupKey: 'drupflare_managed_agency',
		monthly: assumed(
			99,
			'cost plus: about twice the plan cost with every allowance used, $1.98 a site against the $1 floor; Pro plus 47 extra sites would cost $79.50'
		),
		annual: derived(990, 'ten months, the roadmap annual convention'),
		sites: assumed(50, 'roadmap, The Plans "50, blocks of 50"'),
		views: assumed(10000000, 'a fifth of a million views a site, pooled'),
		viewsPooled: true,
		storageGb: assumed(50, 'a gigabyte a site'),
		writes: assumed(10000000, 'a fifth of a million rows a site'),
		backupGb: assumed(50, 'a gigabyte a site'),
		mailSends: assumed(5000, 'inside the 3,000 a month Cloudflare includes per account'),
		containerHours: assumed(5, 'about 50 jobs a month'),
		invitees: assumed(500, 'roadmap, The Plans, Agency 500'),
		support: 'Core',
		supportHoursPerYear: derived(0, NO_HOURS),
		customDomains: assumed(100, 'roadmap, The Plans, Agency 100'),
		backupDays: assumed(30, 'roadmap, The Plans, 30 days'),
		staging: true,
		ssoSaml: null,
		source: 'roadmap, The Plans'
	},
	{
		id: 'institution-starter',
		name: 'Institution Starter',
		kind: 'institution',
		plane: 'managed',
		lookupKey: 'drupflare_institution_starter',
		monthly: derived(1249, 'roadmap, The Plans'),
		annual: derived(14988, 'roadmap, The Plans "annual only"'),
		sites: assumed(75, 'roadmap, The Plans'),
		views: assumed(15000000, 'roadmap, The Plans'),
		viewsPooled: null,
		storageGb: unstated,
		writes: unstated,
		backupGb: unstated,
		mailSends: unstated,
		containerHours: unstated,
		invitees: unstated,
		support: 'Business and 5 hours a month',
		supportHoursPerYear: assumed(60, 'roadmap, The Plans "5 hours" a month, times 12'),
		customDomains: unknown('roadmap gives no custom domain count'),
		backupDays: unknown('roadmap gives no backup days'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap, The Plans'
	},
	{
		id: 'institution-standard',
		name: 'Institution Standard',
		kind: 'institution',
		plane: 'managed',
		lookupKey: 'drupflare_institution_standard',
		monthly: derived(3999, 'roadmap, The Plans'),
		annual: derived(47988, 'roadmap, The Plans "annual prepaid"'),
		sites: assumed(250, 'roadmap, The Plans; blocks of 50 are an add-on'),
		views: assumed(60000000, 'roadmap, The Plans'),
		viewsPooled: null,
		storageGb: unstated,
		writes: unstated,
		backupGb: unstated,
		mailSends: unstated,
		containerHours: unstated,
		invitees: unstated,
		support: 'Business and 16 hours a month',
		supportHoursPerYear: assumed(192, 'roadmap, The Plans "16 hours" a month, times 12'),
		customDomains: unknown('roadmap gives no custom domain count'),
		backupDays: unknown('roadmap gives no backup days'),
		staging: null,
		ssoSaml: true,
		source: 'roadmap, The Plans; roadmap, Institution plans'
	},
	{
		id: 'enterprise',
		name: 'Enterprise',
		kind: 'enterprise',
		plane: 'managed',
		lookupKey: 'drupflare_enterprise',
		monthly: derived(5499, 'roadmap, The Plans "from $5,499"'),
		annual: unknown('roadmap says contract'),
		sites: unknown('roadmap says negotiated'),
		views: unknown('roadmap says negotiated'),
		viewsPooled: null,
		storageGb: unknown('roadmap says negotiated'),
		writes: unknown('roadmap says negotiated'),
		backupGb: unknown('roadmap says negotiated'),
		mailSends: unknown('roadmap says negotiated'),
		containerHours: unknown('roadmap says negotiated'),
		invitees: unknown('roadmap says negotiated'),
		support: 'Critical when staffed',
		supportHoursPerYear: unknown('roadmap lists no hours'),
		customDomains: unknown('roadmap says negotiated'),
		backupDays: unknown('roadmap says negotiated'),
		staging: null,
		ssoSaml: null,
		source: 'roadmap, The Plans'
	}
];

const DEFAULTS = {
	unreviewed: true,
	disabled: false,
	dashboard: true,
	supportLevel: 'community',
	nodes: unknown('the roadmap states instances only for the hosted dashboard link'),
	privateSites: true,
	rollback: null,
	upgrade: null,
	customCode: null,
	strata: true
};

// a flag the roadmap does not state stays null, and null denies. Features are the same on
// every plan; the exceptions are a custom Worker on a shared namespace, and single sign-on
const MANAGED_PAID = { customCode: true, rollback: true, upgrade: true, supportLevel: 'core' };

const OVERRIDES: Record<string, Record<string, unknown>> = {
	'self-hosted': { customCode: true },
	'self-managed': { customCode: true, rollback: true, upgrade: true },
	'self-managed-plus': {
		customCode: true,
		rollback: true,
		upgrade: true,
		supportLevel: 'core'
	},
	'managed-free': { customCode: false, rollback: true, upgrade: true },
	'managed-pro': MANAGED_PAID,
	'managed-agency': MANAGED_PAID,
	'institution-starter': {
		supportLevel: 'business',
		customCode: true,
		rollback: true,
		upgrade: true
	},
	'institution-standard': {
		supportLevel: 'business',
		customCode: true,
		rollback: true,
		upgrade: true
	},
	enterprise: { supportLevel: 'critical', customCode: true, rollback: true, upgrade: true }
};

export const PLANS: readonly Plan[] = z
	.array(planSchema)
	.parse(ROWS.map((row) => ({ ...DEFAULTS, ...row, ...OVERRIDES[row.id] })));

// #region add-ons

export const METER_IDS = [
	'support-hours',
	'support-level',
	'domains',
	'container-hours',
	'backup-storage',
	'mail-sends',
	'sites',
	'views',
	'writes',
	'storage',
	'hostnames',
	'invitees',
	'assurance'
] as const;
export type MeterId = (typeof METER_IDS)[number];

const packSchema = z.object({ units: z.number().positive(), price: figureSchema });

const addOnSchema = z.object({
	id: z.string().min(1),
	name: z.string().min(1),
	meter: z.enum(METER_IDS),
	lookupKey: z.string().min(1),
	// what one unit is, in words a customer reads on the bill
	unit: z.string().min(1),
	// what one subscribed quantity adds to the meter, in the meter's own unit
	grants: z.number().nonnegative(),
	supportLevel: z.enum(SUPPORT_LEVELS).nullable(),
	planes: z.array(z.enum(PLANES)).min(1),
	// base plans that may buy it; null means every plan
	requires: z.array(z.string().min(1)).nullable(),
	// a subscription is one price per unit, billed monthly or annually
	recurring: z.object({ monthly: figureSchema, annual: figureSchema }).nullable(),
	// a one-time purchase is a pack, so a customer can buy a larger one for a lower unit price
	packs: z.array(packSchema),
	// what one unit costs us at list rates, the base the price is set against
	unitCost: figureSchema,
	ssoSaml: z.boolean(),
	available: z.boolean(),
	availableNote: z.string().min(1).nullable(),
	unreviewed: z.boolean(),
	source: z.string().min(1)
});

export type AddOn = z.infer<typeof addOnSchema>;

const ALL_PLANES = ['self-hosted', 'self-managed', 'managed'];
const HOSTED = ['self-managed', 'managed'];
const COMMUNITY_PLANS = [
	'self-hosted',
	'self-managed',
	'self-managed-plus',
	'managed-free',
	'managed-pro'
];
const SURVEY_COST = 'survey of Cloudflare pricing pages, read 2026-11-14';

const ADD_ON_ROWS = [
	{
		id: 'support-hours',
		name: 'Support Hours',
		meter: 'support-hours',
		unit: '1 hour of support',
		// one hour a month is twelve hours a year, the unit the plans state
		grants: 12,
		planes: ALL_PLANES,
		requires: null,
		recurring: {
			monthly: derived(130, 'the 10-hour pack price per hour, roadmap, Support'),
			annual: derived(1300, 'ten months, the roadmap annual convention')
		},
		packs: [
			{ units: 1, price: assumed(150, 'roadmap, Support, extra hours') },
			{ units: 5, price: assumed(700, 'roadmap, Support, pack of 5') },
			{ units: 10, price: assumed(1300, 'roadmap, Support, pack of 10') },
			{ units: 20, price: assumed(2400, 'roadmap, Support, pack of 20') }
		],
		unitCost: derived(62.5, 'loaded rate, roadmap, Pricing'),
		source: 'owner decision 2026-11-14; roadmap, Support'
	},
	{
		id: 'support-core',
		name: 'Core Support',
		meter: 'support-level',
		unit: 'Core support, business hours',
		grants: 1,
		supportLevel: 'core',
		planes: ALL_PLANES,
		requires: ['self-hosted', 'self-managed', 'managed-free'],
		recurring: {
			monthly: assumed(
				4,
				'below Self-Managed Plus at $5, which adds backups and container time to Core response'
			),
			annual: derived(40, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: unknown('a response commitment, priced by the hours it consumes'),
		source: 'roadmap, Support'
	},
	{
		id: 'support-business',
		name: 'Business Support',
		meter: 'support-level',
		unit: 'Business support with a named contact',
		grants: 1,
		supportLevel: 'business',
		planes: ALL_PLANES,
		requires: COMMUNITY_PLANS,
		recurring: {
			monthly: assumed(149, 'roadmap, Support'),
			annual: derived(1490, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: unknown('a response commitment, priced by the hours it consumes'),
		source: 'roadmap, Support'
	},
	{
		id: 'support-critical',
		name: '24/7 Critical Support',
		meter: 'support-level',
		unit: '24/7 critical support',
		grants: 1,
		supportLevel: 'critical',
		planes: ALL_PLANES,
		requires: null,
		recurring: {
			monthly: assumed(999, 'roadmap, Support'),
			annual: derived(9990, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: unknown('needs a second person on rotation'),
		available: false,
		availableNote: 'Not sold until a second person is on the on-call rotation',
		source: 'owner decision 2026-11-14; roadmap, Support'
	},
	{
		id: 'domain',
		name: 'Domain Registration',
		meter: 'domains',
		unit: '1 domain for 1 year',
		grants: 0,
		planes: HOSTED,
		requires: null,
		recurring: null,
		packs: [
			{
				units: 1,
				price: unknown(
					'Cloudflare Registrar price for the extension plus $2 a year; the price is read per domain with POST /domain-check at purchase'
				)
			}
		],
		unitCost: unknown('at cost; Cloudflare states no markup and lists no renewal amounts'),
		available: false,
		availableNote:
			'The Registrar API exists; waiting on a purchase flow that shows the exact price first, since purchases are non-refundable',
		source: 'owner decision 2026-11-14; roadmap, Managed-only Services'
	},
	{
		id: 'container-hours',
		name: 'Container Hours',
		meter: 'container-hours',
		unit: '10 hours of container time',
		grants: 10,
		planes: HOSTED,
		requires: null,
		recurring: {
			monthly: assumed(10, 'about eight times the cost at standard-2'),
			annual: derived(100, 'ten months, the roadmap annual convention')
		},
		packs: [{ units: 1, price: assumed(10, 'about eight times the cost at standard-2') }],
		unitCost: derived(1.29, `10 hours of standard-2 at full CPU; ${SURVEY_COST}`),
		source: 'owner decision 2026-11-14'
	},
	{
		id: 'backup-storage',
		name: 'Backup Storage',
		meter: 'backup-storage',
		unit: '100 GB of backup storage',
		grants: 100,
		planes: ALL_PLANES,
		requires: null,
		recurring: {
			monthly: derived(5, '$0.05 a GB a month, roadmap, Managed-only Services'),
			annual: derived(50, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: derived(1.5, `100 GB at R2 Standard $0.015 a GB; ${SURVEY_COST}`),
		source: 'owner decision 2026-11-14; roadmap, Managed-only Services'
	},
	{
		id: 'mail-sends',
		name: 'Email Sends',
		meter: 'mail-sends',
		unit: '10,000 emails',
		grants: 10000,
		planes: ALL_PLANES,
		requires: null,
		recurring: {
			monthly: derived(
				9,
				'Resend overage, $0.90 per 1,000; survey of sender prices 2026-11-14'
			),
			annual: derived(90, 'ten months, the roadmap annual convention')
		},
		packs: [{ units: 1, price: derived(9, 'Resend overage, $0.90 per 1,000') }],
		unitCost: derived(3.5, `10,000 emails at $0.35 per 1,000; ${SURVEY_COST}`),
		source: 'owner decision 2026-11-14'
	},
	{
		id: 'extra-site',
		name: 'Extra Site',
		meter: 'sites',
		unit: '1 site above the plan',
		grants: 1,
		planes: ['managed'],
		requires: ['managed-pro'],
		recurring: {
			monthly: assumed(
				1.5,
				'cost plus: about four times the raw cost of a kept-warm site, above the $1 floor, below the Pro per-site price of $3'
			),
			annual: derived(15, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: derived(
			0.38,
			'the raw delta of one more kept-warm site past the account allowances, worker docs, economics; not the fleet average, which includes the subscription'
		),
		source: 'owner decision 2026-11-14'
	},
	{
		id: 'site-block-agency',
		name: 'Site Block',
		meter: 'sites',
		unit: '50 sites above the plan',
		grants: 50,
		planes: ['managed'],
		requires: ['managed-agency'],
		recurring: {
			monthly: assumed(99, 'the Agency price for its own 50 sites'),
			annual: derived(990, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: derived(
			18.9,
			'50 kept-warm sites, 50 times the raw delta of $0.378, worker docs'
		),
		source: 'owner decision 2026-11-15; roadmap, The Plans'
	},
	{
		id: 'site-block-standard',
		name: 'Site Block',
		meter: 'sites',
		unit: '50 sites above the plan',
		grants: 50,
		planes: ['managed'],
		requires: ['institution-standard'],
		recurring: {
			monthly: derived(799, 'roadmap, The Plans "blocks of 50 at $799"'),
			annual: derived(9588, 'twelve months of the monthly price')
		},
		packs: [],
		unitCost: derived(
			18.9,
			'50 kept-warm sites, 50 times the raw delta of $0.378, worker docs'
		),
		source: 'roadmap, The Plans'
	},
	{
		id: 'views',
		name: 'Views',
		meter: 'views',
		unit: '1 million views a month',
		grants: 1000000,
		planes: ['managed'],
		requires: null,
		recurring: {
			monthly: derived(
				25,
				'the price per million between the Studio and Agency tiers, about $22 to $27'
			),
			annual: derived(250, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: derived(0.37, 'blended view cost at 1 million views a site, roadmap, Economics'),
		source: 'owner decision 2026-11-14; roadmap, Pricing'
	},
	{
		id: 'writes',
		name: 'Database Writes',
		meter: 'writes',
		unit: '1 million rows written a month',
		grants: 1000000,
		planes: ['managed'],
		requires: null,
		recurring: {
			monthly: assumed(5, 'five times the Cloudflare rate'),
			annual: derived(50, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: published(1, `rows written above 50 million; ${SURVEY_COST}`),
		source: 'owner decision 2026-11-14'
	},
	{
		id: 'storage',
		name: 'Site Storage',
		meter: 'storage',
		unit: '10 GB of site storage',
		grants: 10,
		planes: ['managed'],
		requires: null,
		recurring: {
			monthly: assumed(5, 'two and a half times the Durable Object rate, the costlier store'),
			annual: derived(50, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: derived(2, `10 GB at the Durable Object rate $0.20 a GB; ${SURVEY_COST}`),
		source: 'owner decision 2026-11-14'
	},
	{
		id: 'hostnames',
		name: 'Custom Hostnames',
		meter: 'hostnames',
		unit: '1 custom hostname',
		grants: 1,
		planes: ['managed'],
		requires: null,
		recurring: {
			monthly: assumed(0.5, 'roadmap, Managed-only Services'),
			annual: derived(5, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: assumed(0.1, 'roadmap, Managed-only Services'),
		source: 'roadmap, Managed-only Services'
	},
	{
		id: 'invitees',
		name: 'Private Site Invitees',
		meter: 'invitees',
		unit: '100 invitees',
		grants: 100,
		planes: ['managed'],
		requires: null,
		recurring: {
			monthly: assumed(9, 'roadmap, Managed-only Services'),
			annual: derived(90, 'ten months, the roadmap annual convention')
		},
		packs: [],
		unitCost: unknown('no Cloudflare meter; the gate runs in our own Worker'),
		source: 'roadmap, Managed-only Services'
	},
	{
		id: 'assurance',
		name: 'Assurance',
		meter: 'assurance',
		unit: 'Assurance for Institution Standard',
		grants: 1,
		planes: ['managed'],
		requires: ['institution-standard'],
		recurring: {
			monthly: derived(1500, 'roadmap, The Plans "+$1,500"'),
			annual: derived(18000, 'roadmap, The Plans "+$18,000"')
		},
		packs: [],
		unitCost: unknown('a security packet, a recovery drill and a patch commitment'),
		ssoSaml: true,
		source: 'roadmap, The Plans'
	}
];

const ADD_ON_DEFAULTS = {
	supportLevel: null,
	ssoSaml: false,
	available: true,
	availableNote: null,
	unreviewed: true
};

export const ADD_ONS: readonly AddOn[] = z.array(addOnSchema).parse(
	ADD_ON_ROWS.map((row) => ({
		...ADD_ON_DEFAULTS,
		...row,
		lookupKey: `drupflare_addon_${row.id.replaceAll('-', '_')}`
	}))
);

export function findAddOn(id: string): AddOn | undefined {
	return ADD_ONS.find((addOn) => addOn.id === id);
}

// #endregion

export interface PlanViewer {
	admin: boolean;
}

export function planPricesVisible(
	plan: Plan | AddOn,
	viewer: PlanViewer,
	review: z.infer<typeof reviewSchema> = PLAN_REVIEW
): boolean {
	const disabled = 'disabled' in plan ? plan.disabled : !plan.available;
	return viewer.admin || (priceVisible(review) && !plan.unreviewed && !disabled);
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
		plane: plan.plane,
		lookupKey: plan.lookupKey,
		sites: plan.sites.value,
		sitesUnlimited: 'unlimited' in plan.sites,
		views: plan.views.value,
		support: plan.support,
		supportHoursPerYear: plan.supportHoursPerYear.value,
		included: {
			storageGb: plan.storageGb.value,
			writes: plan.writes.value,
			backupGb: plan.backupGb.value,
			mailSends: plan.mailSends.value,
			containerHours: plan.containerHours.value,
			invitees: plan.invitees.value,
			customDomains: plan.customDomains.value,
			backupDays: plan.backupDays.value
		},
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

export function describeAddOn(
	addOn: AddOn,
	viewer: PlanViewer,
	review: z.infer<typeof reviewSchema> = PLAN_REVIEW
) {
	const shown = {
		id: addOn.id,
		name: addOn.name,
		meter: addOn.meter,
		lookupKey: addOn.lookupKey,
		unit: addOn.unit,
		grants: addOn.grants,
		planes: addOn.planes,
		requires: addOn.requires,
		subscription: addOn.recurring !== null,
		packSizes: addOn.packs.map((pack) => pack.units),
		available: addOn.available,
		availableNote: addOn.availableNote
	};
	if (!planPricesVisible(addOn, viewer, review)) return shown;
	return {
		...shown,
		monthly: addOn.recurring?.monthly.value ?? null,
		annual: addOn.recurring?.annual.value ?? null,
		packs: addOn.packs.map((pack) => ({ units: pack.units, price: pack.price.value })),
		unreviewed: addOn.unreviewed
	};
}

// a customer can buy an add-on when it runs on their plane and their plan is one it names
export function addOnOffered(addOn: AddOn, plan: Plan): boolean {
	if (!addOn.planes.includes(plan.plane)) return false;
	return addOn.requires === null || addOn.requires.includes(plan.id);
}

export function findPlan(id: string): Plan | undefined {
	return PLANS.find((plan) => plan.id === id);
}

export const INTERVALS = ['month', 'year'] as const;
export type Interval = (typeof INTERVALS)[number];

// the stripe price lookup key: one product per plan, one price per interval
export function priceLookupKey(plan: Pick<Plan | AddOn, 'lookupKey'>, interval: Interval): string {
	return `${plan.lookupKey}_${interval === 'month' ? 'monthly' : 'annual'}`;
}

export function packLookupKey(addOn: Pick<AddOn, 'lookupKey'>, units: number): string {
	return `${addOn.lookupKey}_pack_${units}`;
}

export function planFromPriceKey(key: string): { plan: Plan; interval: Interval } | undefined {
	for (const plan of PLANS) {
		for (const interval of INTERVALS) {
			if (priceLookupKey(plan, interval) === key) return { plan, interval };
		}
	}
	return undefined;
}

export type OfferKey =
	| { kind: 'plan'; plan: Plan; interval: Interval }
	| { kind: 'add-on'; addOn: AddOn; interval: Interval }
	| { kind: 'pack'; addOn: AddOn; units: number };

export function offerFromPriceKey(key: string): OfferKey | undefined {
	const plan = planFromPriceKey(key);
	if (plan) return { kind: 'plan', ...plan };
	for (const addOn of ADD_ONS) {
		if (addOn.recurring !== null) {
			for (const interval of INTERVALS) {
				if (priceLookupKey(addOn, interval) === key) {
					return { kind: 'add-on', addOn, interval };
				}
			}
		}
		for (const pack of addOn.packs) {
			if (packLookupKey(addOn, pack.units) === key) {
				return { kind: 'pack', addOn, units: pack.units };
			}
		}
	}
	return undefined;
}

export function intervalPrice(plan: Plan | AddOn, interval: Interval): number | null {
	if ('recurring' in plan) {
		const recurring = plan.recurring;
		if (recurring === null) return null;
		return (interval === 'month' ? recurring.monthly : recurring.annual).value;
	}
	return (interval === 'month' ? plan.monthly : plan.annual).value;
}
