import {
	effectiveState,
	evaluateBudget,
	type AlertKey,
	type Budget,
	type Evaluation,
	type SentAlert,
	type SiteState
} from '../../shared/budget-rules';
import type { AuditInput } from './audit';

export type BudgetMode = 'shadow' | 'on';

// the flag: anything but "on" is shadow, so a missing or misspelt value never blocks a site
export function budgetModeOf(value: unknown): BudgetMode {
	return value === 'on' ? 'on' : 'shadow';
}

export type EnforcedBudget = Pick<Budget, 'percent' | 'enforcement'>;

export interface SiteBudgetInput {
	siteId: string;
	allowanceViews: number | null;
	// null: the site has no budget of its own
	budget: EnforcedBudget | null;
}

export interface OrgBudgetInput {
	orgId: string;
	allowanceViews: number | null;
	budget: EnforcedBudget | null;
	sites: SiteBudgetInput[];
}

// what budgets exist is stored by the budget screens; this service only reads them
export interface BudgetSource {
	organizations(): Promise<OrgBudgetInput[]>;
	organization(orgId: string): Promise<OrgBudgetInput | null>;
}

// month-to-date views the counter acknowledged, a lower bound; null when it could not be read
export interface CountsReader {
	monthViews(siteId: string, period: string): Promise<number | null>;
	// one read for many sites; a site missing from the answer is unreadable
	monthViewsMany?(
		siteIds: readonly string[],
		period: string
	): Promise<Map<string, number | null>>;
}

export type BudgetWrite =
	| { outcome: 'written'; generation: number }
	| { outcome: 'unchanged'; generation: number }
	| { outcome: 'security-state' | 'unknown-site' };

export interface AuthorityWriter {
	applyBudgetState(
		siteId: string,
		input: { state: 'ok' | 'over-budget'; blockAtViews: number | null }
	): Promise<BudgetWrite>;
	// one batch for many sites; a site that failed answers with an Error
	applyBudgetStates?(
		writes: { siteId: string; state: 'ok' | 'over-budget'; blockAtViews: number | null }[]
	): Promise<Map<string, BudgetWrite | Error>>;
}

export interface StateRecord {
	state: 'ok' | 'over-budget';
	reason: 'site-budget' | 'org-budget' | null;
	// a shadow record says nothing about what the lease holds, so a switch to `on` starts again
	mode: BudgetMode;
	// what the lease was last given: a site whose answer has not changed sends no write
	blockAtViews?: number | null;
	writtenAt?: number;
}

// the last state this service reported for a site, so an audit row marks a change and not a minute
export interface StateLedger {
	get(siteId: string): Promise<StateRecord | null>;
	getMany?(siteIds: readonly string[]): Promise<Map<string, StateRecord>>;
	set(siteId: string, record: StateRecord): Promise<void>;
}

// a write that the ledger says is unchanged is sent again this often, in case the lease moved
export const REASSERT_MS = 60 * 60_000;

// what one evaluation found newly crossed for the organisation (siteId null) or one site
export interface AlertNotice {
	orgId: string;
	siteId: string | null;
	period: string;
	alerts: AlertKey[];
	budget: EnforcedBudget;
	allowanceViews: number | null;
	views: number | null;
	mode: BudgetMode;
}

// the sink owns the once-per-period record: `sent` feeds the evaluation, `notify` mails and records
export interface AlertSink {
	sent(orgId: string, siteId: string | null, period: string): Promise<SentAlert[]>;
	notify(notice: AlertNotice): Promise<void>;
}

export interface BudgetEnforcementDeps {
	alerts?: AlertSink;
	mode: BudgetMode;
	now(): number;
	source: BudgetSource;
	counts: CountsReader;
	authority: AuthorityWriter;
	ledger: StateLedger;
	audit(orgId: string, input: AuditInput): Promise<unknown>;
	log(message: string, detail: Record<string, unknown>): void;
}

export interface SiteOutcome {
	siteId: string;
	state: 'ok' | 'over-budget';
	blockAtViews: number | null;
	action:
		'blocked' | 'unblocked' | 'would-block' | 'would-unblock' | 'unchanged' | 'held' | 'failed';
	message?: string;
}

export interface OrgOutcome {
	orgId: string;
	sites: SiteOutcome[];
}

const ACTOR = 'system:budget-enforcement';

export const periodOf = (at: number): string => new Date(at).toISOString().slice(0, 7);

// the lowest month-to-date count at which one site is refused: its own hard cap, or what the
// organisation's hard cap has left on top of what the site has already served
export function blockThreshold(input: {
	site: SiteBudgetInput;
	org: Pick<OrgBudgetInput, 'allowanceViews' | 'budget'>;
	siteViews: number | null;
	orgViews: number | null;
}): number | null {
	const { site, org } = input;
	const caps: number[] = [];
	if (site.budget?.enforcement === 'block' && site.allowanceViews !== null) {
		caps.push(capOf(site.allowanceViews, site.budget.percent));
	}
	if (
		org.budget?.enforcement === 'block' &&
		org.allowanceViews !== null &&
		input.siteViews !== null &&
		input.orgViews !== null
	) {
		const room = Math.max(0, capOf(org.allowanceViews, org.budget.percent) - input.orgViews);
		caps.push(input.siteViews + room);
	}
	return caps.length === 0 ? null : Math.min(...caps);
}

const known = (value: number | null): value is number => value !== null;

// whole views, in the same tenths-of-a-percent integer maths `evaluateBudget` uses, so the local
// threshold and the evaluation agree on the exact view
const capOf = (allowanceViews: number, percent: number): number =>
	Math.ceil((allowanceViews * Math.round(percent * 10)) / 1000);

// what one site needs from this evaluation, before anything is written
interface SitePlan {
	org: OrgBudgetInput;
	site: SiteBudgetInput;
	next: SiteState;
	blockAtViews: number | null;
	siteViews: number | null;
	orgViews: number | null;
	complete: boolean;
	period: string;
}

const messageOf = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

// one read for every site of the run; an unreadable site is null, never zero
async function readCounts(
	deps: BudgetEnforcementDeps,
	siteIds: readonly string[],
	period: string
): Promise<Map<string, number | null>> {
	const out = new Map<string, number | null>();
	if (deps.counts.monthViewsMany !== undefined) {
		try {
			for (const [siteId, views] of await deps.counts.monthViewsMany(siteIds, period)) {
				out.set(siteId, views);
			}
		} catch {
			// every site stays unreadable
		}
		return out;
	}
	await Promise.all(
		siteIds.map(async (siteId) => {
			try {
				out.set(siteId, await deps.counts.monthViews(siteId, period));
			} catch {
				out.set(siteId, null);
			}
		})
	);
	return out;
}

// the alerts and the state of each site of one organisation; nothing is written here
async function planOrganization(
	deps: BudgetEnforcementDeps,
	org: OrgBudgetInput,
	allCounts: Map<string, number | null>,
	period: string
): Promise<SitePlan[]> {
	const counts = org.sites.map((site) => allCounts.get(site.siteId) ?? null);
	const readable = counts.filter(known);
	const complete = readable.length === counts.length;
	const orgViews = readable.length === 0 ? null : readable.reduce((a, b) => a + b, 0);

	const sentFor = async (siteId: string | null): Promise<SentAlert[]> => {
		if (deps.alerts === undefined) return [];
		try {
			return await deps.alerts.sent(org.orgId, siteId, period);
		} catch {
			return [];
		}
	};
	const evaluate = (
		budget: EnforcedBudget | null,
		allowanceViews: number | null,
		views: number | null,
		sentAlerts: SentAlert[]
	): Evaluation | null =>
		budget === null
			? null
			: evaluateBudget({
					budget,
					allowanceViews,
					viewsLowerBound: views,
					sentAlerts,
					period
				});
	// an alert that cannot be sent never stops the evaluation or the block
	const announce = async (
		siteId: string | null,
		budget: EnforcedBudget | null,
		allowanceViews: number | null,
		views: number | null,
		evaluation: Evaluation | null
	): Promise<void> => {
		if (deps.alerts === undefined || budget === null || evaluation === null) return;
		if (evaluation.alerts.length === 0) return;
		try {
			await deps.alerts.notify({
				orgId: org.orgId,
				siteId,
				period,
				alerts: evaluation.alerts,
				budget,
				allowanceViews,
				views,
				mode: deps.mode
			});
		} catch (error) {
			deps.log('budget alert failed', {
				orgId: org.orgId,
				siteId,
				message: messageOf(error)
			});
		}
	};

	const orgEvaluation = evaluate(org.budget, org.allowanceViews, orgViews, await sentFor(null));
	await announce(null, org.budget, org.allowanceViews, orgViews, orgEvaluation);
	const siteEvaluations = await Promise.all(
		org.sites.map(async (site, index) =>
			evaluate(
				site.budget,
				site.allowanceViews,
				counts[index] ?? null,
				await sentFor(site.siteId)
			)
		)
	);
	for (const [index, site] of org.sites.entries()) {
		await announce(
			site.siteId,
			site.budget,
			site.allowanceViews,
			counts[index] ?? null,
			siteEvaluations[index] ?? null
		);
	}
	const states = effectiveState({
		org: orgEvaluation,
		sites: org.sites.map((site, index) => ({
			siteId: site.siteId,
			evaluation: siteEvaluations[index] ?? null
		}))
	});

	return org.sites.map((site, index) => {
		const siteViews = counts[index] ?? null;
		const next: SiteState = states[site.siteId] ?? { state: 'ok', reason: null };
		const blockAtViews =
			next.state === 'over-budget'
				? null
				: blockThreshold({ site, org, siteViews, orgViews });
		return { org, site, next, blockAtViews, siteViews, orgViews, complete, period };
	});
}

export interface RunStats {
	writes: number;
}

type Prior = StateRecord | null | Error;

async function readLedger(
	deps: BudgetEnforcementDeps,
	siteIds: readonly string[]
): Promise<Map<string, Prior>> {
	const out = new Map<string, Prior>();
	if (deps.ledger.getMany !== undefined) {
		try {
			const found = await deps.ledger.getMany(siteIds);
			for (const siteId of siteIds) out.set(siteId, found.get(siteId) ?? null);
		} catch (error) {
			for (const siteId of siteIds) out.set(siteId, new Error(messageOf(error)));
		}
		return out;
	}
	await Promise.all(
		siteIds.map(async (siteId) => {
			try {
				out.set(siteId, await deps.ledger.get(siteId));
			} catch (error) {
				out.set(siteId, new Error(messageOf(error)));
			}
		})
	);
	return out;
}

type WriteRequest = { siteId: string; state: 'ok' | 'over-budget'; blockAtViews: number | null };

// one batch for the whole run when the writer has one, else one call a site; a site that fails
// answers with an Error and never stops the others
async function writeStates(
	deps: BudgetEnforcementDeps,
	requests: WriteRequest[]
): Promise<Map<string, BudgetWrite | Error>> {
	const out = new Map<string, BudgetWrite | Error>();
	if (requests.length === 0) return out;
	if (deps.authority.applyBudgetStates !== undefined) {
		try {
			for (const [siteId, answer] of await deps.authority.applyBudgetStates(requests)) {
				out.set(siteId, answer);
			}
		} catch (error) {
			for (const { siteId } of requests) out.set(siteId, new Error(messageOf(error)));
		}
		for (const { siteId } of requests) {
			if (!out.has(siteId))
				out.set(siteId, new Error('the engine gave no answer for the site'));
		}
		return out;
	}
	for (const { siteId, state, blockAtViews } of requests) {
		try {
			out.set(siteId, await deps.authority.applyBudgetState(siteId, { state, blockAtViews }));
		} catch (error) {
			out.set(siteId, new Error(messageOf(error)));
		}
	}
	return out;
}

const detailOf = (plan: SitePlan) => ({
	reason: plan.next.reason,
	period: plan.period,
	siteViews: plan.siteViews,
	orgViews: plan.orgViews,
	siteAllowance: plan.site.allowanceViews,
	orgAllowance: plan.org.allowanceViews,
	sitePercent: plan.site.budget?.percent ?? null,
	orgPercent: plan.org.budget?.percent ?? null
});

// decides every site first, sends one batch of writes, then audits and records each result
async function settleAll(
	deps: BudgetEnforcementDeps,
	plans: SitePlan[],
	stats: RunStats
): Promise<Map<string, SiteOutcome>> {
	const priors = await readLedger(
		deps,
		plans.map((plan) => plan.site.siteId)
	);
	const nowMs = deps.now();
	const settled = new Map<string, SiteOutcome>();
	const pending: { plan: SitePlan; record: StateRecord | null; before: 'ok' | 'over-budget' }[] =
		[];

	for (const plan of plans) {
		const { site, org, next, blockAtViews } = plan;
		const base = { siteId: site.siteId, state: next.state, blockAtViews };
		const prior = priors.get(site.siteId) ?? null;
		if (prior instanceof Error) {
			settled.set(site.siteId, { ...base, action: 'failed', message: prior.message });
			continue;
		}
		const before = prior?.mode === deps.mode ? prior.state : 'ok';
		// a count or an allowance that could not be read says nothing about whether the cap was lifted
		const allowanceMissing =
			(site.budget !== null && site.allowanceViews === null) ||
			(org.budget !== null && org.allowanceViews === null);
		if (
			before === 'over-budget' &&
			next.state === 'ok' &&
			(!plan.complete || allowanceMissing)
		) {
			settled.set(site.siteId, { ...base, action: 'held' });
			continue;
		}
		// the ledger holds what was last written, so an unchanged site sends nothing; the write is
		// repeated once an hour in case something else changed the lease since
		if (
			deps.mode === 'on' &&
			prior !== null &&
			prior.mode === 'on' &&
			prior.state === next.state &&
			prior.blockAtViews === blockAtViews &&
			prior.writtenAt !== undefined &&
			nowMs - prior.writtenAt < REASSERT_MS
		) {
			settled.set(site.siteId, { ...base, action: 'unchanged' });
			continue;
		}
		pending.push({ plan, record: prior, before });
	}

	const writes =
		deps.mode === 'on'
			? await writeStates(
					deps,
					pending.map(({ plan }) => ({
						siteId: plan.site.siteId,
						state: plan.next.state,
						blockAtViews: plan.blockAtViews
					}))
				)
			: new Map<string, BudgetWrite | Error>();
	if (deps.mode === 'on') stats.writes += pending.length;

	for (const { plan, before } of pending) {
		const { site, next, blockAtViews } = plan;
		const base = { siteId: site.siteId, state: next.state, blockAtViews };
		try {
			settled.set(
				site.siteId,
				await finish(deps, plan, before, writes.get(site.siteId) ?? null, nowMs)
			);
		} catch (error) {
			settled.set(site.siteId, { ...base, action: 'failed', message: messageOf(error) });
		}
	}
	return settled;
}

async function finish(
	deps: BudgetEnforcementDeps,
	plan: SitePlan,
	before: 'ok' | 'over-budget',
	write: BudgetWrite | Error | null,
	nowMs: number
): Promise<SiteOutcome> {
	const { site, org, next, blockAtViews } = plan;
	const base = { siteId: site.siteId, state: next.state, blockAtViews };
	const detail = detailOf(plan);
	const changed = before !== next.state;
	const record: StateRecord = {
		state: next.state,
		reason: next.reason,
		mode: deps.mode,
		blockAtViews,
		writtenAt: nowMs
	};

	if (deps.mode === 'shadow') {
		if (!changed) return { ...base, action: 'unchanged' };
		const action = next.state === 'over-budget' ? 'would-block' : 'would-unblock';
		if (next.state === 'over-budget') {
			deps.log('budget enforcement would block', { siteId: site.siteId, ...detail });
		}
		await deps.audit(org.orgId, {
			actor: ACTOR,
			action: next.state === 'over-budget' ? 'budget.would-block' : 'budget.would-unblock',
			target: site.siteId,
			detail
		});
		await deps.ledger.set(site.siteId, record);
		return { ...base, action };
	}

	if (write === null) return { ...base, action: 'failed', message: 'no write was made' };
	if (write instanceof Error) throw write;
	if (write.outcome === 'security-state' || write.outcome === 'unknown-site') {
		return { ...base, action: 'held', message: write.outcome };
	}
	if (!changed) {
		await deps.ledger.set(site.siteId, record);
		return { ...base, action: 'unchanged' };
	}
	await deps.audit(org.orgId, {
		actor: ACTOR,
		action: next.state === 'over-budget' ? 'budget.block' : 'budget.unblock',
		target: site.siteId,
		detail: { ...detail, blockAtViews }
	});
	await deps.ledger.set(site.siteId, record);
	return { ...base, action: next.state === 'over-budget' ? 'blocked' : 'unblocked' };
}

// counts for every site come in one read and the writes go out in one batch; an organisation that
// cannot be planned is logged and left out when `isolate` is set, else its error is thrown
async function runOrganizations(
	deps: BudgetEnforcementDeps,
	orgs: OrgBudgetInput[],
	isolate: boolean,
	stats: RunStats
): Promise<OrgOutcome[]> {
	const period = periodOf(deps.now());
	// an organisation that cannot be read is left out here and fails on its own below
	const siteIds = orgs.flatMap((org) => {
		try {
			return org.sites.map((site) => site.siteId);
		} catch {
			return [];
		}
	});
	const counts = await readCounts(deps, siteIds, period);
	const planned: { org: OrgBudgetInput; plans: SitePlan[] }[] = [];
	for (const org of orgs) {
		try {
			planned.push({ org, plans: await planOrganization(deps, org, counts, period) });
		} catch (error) {
			if (!isolate) throw error;
			deps.log('budget evaluation failed for an organisation', {
				orgId: org.orgId,
				message: messageOf(error)
			});
		}
	}
	const settled = await settleAll(
		deps,
		planned.flatMap((entry) => entry.plans),
		stats
	);
	return planned.map(({ org, plans }) => ({
		orgId: org.orgId,
		sites: plans.map((plan) => settled.get(plan.site.siteId) as SiteOutcome)
	}));
}

export async function evaluateOrganization(
	deps: BudgetEnforcementDeps,
	org: OrgBudgetInput
): Promise<OrgOutcome> {
	const [outcome] = await runOrganizations(deps, [org], false, { writes: 0 });
	return outcome as OrgOutcome;
}

export async function evaluateAllBudgets(deps: BudgetEnforcementDeps): Promise<OrgOutcome[]> {
	const stats: RunStats = { writes: 0 };
	const out = await runOrganizations(deps, await deps.source.organizations(), true, stats);
	const actions = out.flatMap((org) => org.sites.map((site) => site.action));
	const count = (action: SiteOutcome['action']) => actions.filter((a) => a === action).length;
	deps.log('budget evaluation run', {
		mode: deps.mode,
		organisations: out.length,
		sites: actions.length,
		writesSent: stats.writes,
		blocked: count('blocked'),
		unblocked: count('unblocked'),
		wouldBlock: count('would-block'),
		held: count('held'),
		errors: count('failed')
	});
	return out;
}

// a raised or lowered cap applies at once instead of at the next minute
export async function reevaluate(
	deps: BudgetEnforcementDeps,
	orgId: string
): Promise<OrgOutcome | null> {
	const org = await deps.source.organization(orgId);
	return org === null ? null : evaluateOrganization(deps, org);
}
