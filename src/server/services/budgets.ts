import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	OVERSHOOT_BOUND_SENTENCE,
	budgetDollars,
	evaluateBudget,
	validatePercent,
	viewsUnitRate,
	type AlertKey,
	type Enforcement,
	type EvaluationFlag,
	type Money
} from '../../shared/budget-rules';
import { ApiError } from '../../shared/errors';
import { SPEND_BUDGET } from '../../shared/plans';
import {
	budgetedViews,
	getOrgBudget,
	getSiteBudget,
	listAlertsSent,
	putBudget,
	seedOrgBudget,
	type BudgetRow
} from '../db/repos/budgets';
import type { Entitlement } from '../domain/entitlements';
import type { AuditInput } from './audit';
import {
	periodOf,
	reevaluate,
	type BudgetEnforcementDeps,
	type BudgetMode,
	type BudgetSource,
	type OrgBudgetInput
} from './budget-enforcement';

// #region collaborators

export interface BudgetStore {
	getOrg(orgId: string): Promise<BudgetRow | null>;
	getSite(orgId: string, siteId: string): Promise<BudgetRow | null>;
	put(row: BudgetRow): Promise<void>;
	// true when the row was created; an existing organisation row is never replaced
	seed(row: BudgetRow): Promise<boolean>;
	alertsSent(orgId: string, period: string): Promise<{ scopeKey: string; alertKey: string }[]>;
}

export interface BudgetServices {
	store: BudgetStore;
	source: BudgetSource;
	planOf(orgId: string): Promise<Entitlement>;
	audit(orgId: string, input: AuditInput): Promise<unknown>;
	// null until the production ports of the evaluation are installed
	enforcement(): BudgetEnforcementDeps | null;
	mode(): BudgetMode;
	// the BILLING_OVERAGE_ENABLED read; when off, no overage is billed and the screen says so
	overageBilled(): boolean;
	newId(): string;
	now(): number;
}

let installed: BudgetServices | null = null;

export function setBudgetServices(services: BudgetServices | null): void {
	installed = services;
}

export function budgetServices(): BudgetServices {
	if (installed === null) throw new ApiError('not_built', 'Budgets are not available yet');
	return installed;
}

export function collegeBudgetStore(getDb: () => Promise<CollegeDBClient>): BudgetStore {
	return {
		async getOrg(orgId) {
			return getOrgBudget(await getDb(), orgId);
		},
		async getSite(orgId, siteId) {
			return getSiteBudget(await getDb(), orgId, siteId);
		},
		async put(row) {
			await putBudget(await getDb(), row);
		},
		async seed(row) {
			return seedOrgBudget(await getDb(), row);
		},
		async alertsSent(orgId, period) {
			return (await listAlertsSent(await getDb(), orgId, period)).map((row) => ({
				scopeKey: row.scopeKey,
				alertKey: row.alertKey
			}));
		}
	};
}

// #endregion

const SEED_ACTOR = 'system:budget-default';

export const NOT_APPLICABLE = { status: 'not_applicable' } as const;

// #region defaults

// a paid plan with a counted allowance gets the default hard budget once; a row that is already
// there is the customer's choice and stays
export async function seedOrgBudgetFor(
	s: BudgetServices,
	orgId: string
): Promise<'seeded' | 'kept' | 'not-applicable'> {
	if (budgetedViews(await s.planOf(orgId)) === null) return 'not-applicable';
	const now = s.now();
	const created = await s.store.seed({
		id: s.newId(),
		organizationId: orgId,
		scope: 'org',
		siteId: null,
		percent: SPEND_BUDGET.defaultPercent.value,
		enforcement: 'block',
		setBy: SEED_ACTOR,
		setAt: now
	});
	if (!created) return 'kept';
	await s.audit(orgId, {
		actor: SEED_ACTOR,
		action: 'budget.seed',
		target: orgId,
		detail: {
			scope: 'org',
			percent: SPEND_BUDGET.defaultPercent.value,
			enforcement: 'block'
		}
	});
	return 'seeded';
}

// #endregion

// #region reads

export interface BudgetView {
	status: 'ok';
	scope: 'org' | 'site';
	siteId: string | null;
	// null: a site with no budget of its own, which the organisation's budget governs
	percent: number | null;
	enforcement: Enforcement | null;
	// true when the owner set this row; false for a default
	ownerSet: boolean;
	allowanceViews: number | null;
	dollars: Money | null;
	viewsLowerBound: number | null;
	accounting: 'counted' | 'unavailable';
	state: 'ok' | 'over-budget' | 'would-block';
	flags: EvaluationFlag[];
	alertsSent: AlertKey[];
	enforcementFlag: BudgetMode;
	overageBilled: boolean;
	appliesWithin: string;
}

export type BudgetReply = BudgetView | typeof NOT_APPLICABLE;

async function viewOf(
	s: BudgetServices,
	input: {
		orgId: string;
		siteId: string | null;
		budget: { percent: number; enforcement: Enforcement } | null;
		allowanceViews: number | null;
		ownerSet: boolean;
	}
): Promise<BudgetView> {
	const deps = s.enforcement();
	const mode = deps?.mode ?? s.mode();
	const period = periodOf(s.now());
	let views: number | null = null;
	if (deps !== null) {
		try {
			// a site's own count; the organisation's count is the sum over its sites
			if (input.siteId !== null) views = await deps.counts.monthViews(input.siteId, period);
			else {
				const org = await s.source.organization(input.orgId);
				const counts = await Promise.all(
					(org?.sites ?? []).map((site) =>
						deps.counts.monthViews(site.siteId, period).catch(() => null)
					)
				);
				views = counts.some((count) => count === null)
					? null
					: counts.reduce<number>((a, b) => a + (b ?? 0), 0);
			}
		} catch {
			views = null;
		}
	}
	const evaluation =
		input.budget === null
			? null
			: evaluateBudget({
					budget: input.budget,
					allowanceViews: input.allowanceViews,
					viewsLowerBound: views,
					sentAlerts: [],
					period
				});
	const scopeKey = input.siteId === null ? 'org' : `site:${input.siteId}`;
	const sent = (await s.store.alertsSent(input.orgId, period))
		.filter((row) => row.scopeKey === scopeKey)
		.map((row) => row.alertKey as AlertKey);
	let state: BudgetView['state'] = 'ok';
	if (evaluation?.state === 'over-budget') state = mode === 'on' ? 'over-budget' : 'would-block';
	return {
		status: 'ok',
		scope: input.siteId === null ? 'org' : 'site',
		siteId: input.siteId,
		percent: input.budget?.percent ?? null,
		enforcement: input.budget?.enforcement ?? null,
		ownerSet: input.ownerSet,
		allowanceViews: input.allowanceViews,
		dollars:
			input.budget === null || input.allowanceViews === null
				? null
				: budgetDollars(input.budget.percent, input.allowanceViews, viewsUnitRate()),
		viewsLowerBound: views,
		accounting: views === null ? 'unavailable' : 'counted',
		state,
		flags: evaluation?.flags ?? [],
		alertsSent: sent,
		enforcementFlag: mode,
		overageBilled: s.overageBilled(),
		appliesWithin: OVERSHOOT_BOUND_SENTENCE
	};
}

async function applicable(s: BudgetServices, orgId: string): Promise<OrgBudgetInput | null> {
	if (budgetedViews(await s.planOf(orgId)) === null) return null;
	// an account activated before budgets existed gets its default the first time it looks
	await seedOrgBudgetFor(s, orgId);
	return s.source.organization(orgId);
}

export async function readOrgBudget(s: BudgetServices, orgId: string): Promise<BudgetReply> {
	const org = await applicable(s, orgId);
	if (org === null || org.budget === null) return NOT_APPLICABLE;
	return viewOf(s, {
		orgId,
		siteId: null,
		budget: org.budget,
		allowanceViews: org.allowanceViews,
		ownerSet: (await s.store.getOrg(orgId))?.setBy !== SEED_ACTOR
	});
}

export async function readSiteBudget(
	s: BudgetServices,
	orgId: string,
	siteId: string
): Promise<BudgetReply> {
	const org = await applicable(s, orgId);
	if (org === null || org.budget === null) return NOT_APPLICABLE;
	const site = org.sites.find((one) => one.siteId === siteId);
	if (site === undefined) throw new ApiError('not_found', 'Not found');
	return viewOf(s, {
		orgId,
		siteId,
		budget: site.budget,
		allowanceViews: site.allowanceViews,
		ownerSet: (await s.store.getSite(orgId, siteId)) !== null
	});
}

// #endregion

// #region writes

export interface BudgetChange {
	percent: unknown;
	enforcement: Enforcement;
}

export interface BudgetWriteInput {
	orgId: string;
	actor: string;
	// a user session that signed in again recently; a key never is
	fresh: boolean;
	change: BudgetChange;
}

export type BudgetWriteReply = BudgetView & { changed: boolean };

// a higher percent, or a switch from hard to soft, loosens protection and needs a fresh session
export function loosens(
	before: { percent: number; enforcement: Enforcement } | null,
	after: { percent: number; enforcement: Enforcement }
): boolean {
	if (before === null) return false;
	return (
		after.percent > before.percent ||
		(before.enforcement === 'block' && after.enforcement === 'alert')
	);
}

function checked(change: BudgetChange): { percent: number; enforcement: Enforcement } {
	const result = validatePercent(change.percent);
	if (!result.ok) throw new ApiError('validation', result.message, { reason: result.reason });
	return { percent: result.percent, enforcement: change.enforcement };
}

function requireFresh(fresh: boolean): void {
	if (!fresh) {
		throw new ApiError('forbidden', 'Fresh authentication is required to raise a budget', {
			requires: 'step-up'
		});
	}
}

// the evaluation runs again so a changed cap applies without waiting for the next minute; it is
// best effort, since the scheduled run reaches the same state
async function applyNow(s: BudgetServices, orgId: string): Promise<void> {
	const deps = s.enforcement();
	if (deps === null) return;
	try {
		await reevaluate(deps, orgId);
	} catch (error) {
		deps.log('budget re-evaluation failed', {
			orgId,
			message: error instanceof Error ? error.message : String(error)
		});
	}
}

export async function setOrgBudget(
	s: BudgetServices,
	input: BudgetWriteInput
): Promise<BudgetWriteReply | typeof NOT_APPLICABLE> {
	const next = checked(input.change);
	const org = await applicable(s, input.orgId);
	if (org === null || org.budget === null) return NOT_APPLICABLE;
	const before = org.budget;
	if (loosens(before, next)) requireFresh(input.fresh);
	const changed = before.percent !== next.percent || before.enforcement !== next.enforcement;
	if (changed) {
		await s.store.put({
			id: s.newId(),
			organizationId: input.orgId,
			scope: 'org',
			siteId: null,
			percent: next.percent,
			enforcement: next.enforcement,
			setBy: input.actor,
			setAt: s.now()
		});
		await s.audit(input.orgId, {
			actor: input.actor,
			action: 'budget.set',
			target: input.orgId,
			detail: {
				scope: 'org',
				old: { percent: before.percent, enforcement: before.enforcement },
				new: next
			}
		});
		await applyNow(s, input.orgId);
	}
	const reply = await readOrgBudget(s, input.orgId);
	return reply.status === 'ok' ? { ...reply, changed } : reply;
}

export async function setSiteBudget(
	s: BudgetServices,
	input: BudgetWriteInput & { siteId: string }
): Promise<BudgetWriteReply | typeof NOT_APPLICABLE> {
	const next = checked(input.change);
	const org = await applicable(s, input.orgId);
	if (org === null || org.budget === null) return NOT_APPLICABLE;
	const site = org.sites.find((one) => one.siteId === input.siteId);
	if (site === undefined) throw new ApiError('not_found', 'Not found');
	if (next.percent > org.budget.percent) {
		throw new ApiError(
			'validation',
			`A site budget cannot be higher than the organisation budget of ${org.budget.percent} percent.`,
			{ reason: 'above-organization' }
		);
	}
	const before = site.budget;
	if (loosens(before, next)) requireFresh(input.fresh);
	const changed =
		before === null ||
		before.percent !== next.percent ||
		before.enforcement !== next.enforcement;
	if (changed) {
		await s.store.put({
			id: s.newId(),
			organizationId: input.orgId,
			scope: 'site',
			siteId: input.siteId,
			percent: next.percent,
			enforcement: next.enforcement,
			setBy: input.actor,
			setAt: s.now()
		});
		await s.audit(input.orgId, {
			actor: input.actor,
			action: 'budget.set',
			target: input.siteId,
			detail: {
				scope: 'site',
				old: before === null ? null : { ...before },
				new: next
			}
		});
		await applyNow(s, input.orgId);
	}
	const reply = await readSiteBudget(s, input.orgId, input.siteId);
	return reply.status === 'ok' ? { ...reply, changed } : reply;
}

// #endregion
