import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	clampSiteToOrg,
	siteBudgetDefault,
	type BudgetScope,
	type Enforcement
} from '../../../shared/budget-rules';
import { findPlan } from '../../../shared/plans';
import { managedIsFree, type Entitlement } from '../../domain/entitlements';
import type {
	BudgetSource,
	OrgBudgetInput,
	SiteBudgetInput
} from '../../services/budget-enforcement';
import { wasChanged } from '../collegedb';

// #region rows

export interface BudgetRow {
	id: string;
	organizationId: string;
	scope: BudgetScope;
	siteId: string | null;
	percent: number;
	enforcement: Enforcement;
	setBy: string;
	setAt: number;
}

interface BudgetDb {
	id: string;
	organization_id: string;
	scope: BudgetScope;
	site_id: string | null;
	percent: number;
	enforcement: Enforcement;
	set_by: string;
	set_at: number;
}

const COLUMNS = 'id, organization_id, scope, site_id, percent, enforcement, set_by, set_at';

function toRow(row: BudgetDb): BudgetRow {
	return {
		id: row.id,
		organizationId: row.organization_id,
		scope: row.scope,
		siteId: row.site_id,
		percent: row.percent,
		enforcement: row.enforcement,
		setBy: row.set_by,
		setAt: row.set_at
	};
}

export async function listBudgetRows(
	db: CollegeDBClient,
	organizationId: string
): Promise<BudgetRow[]> {
	const { results } = await db.all<BudgetDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM budgets WHERE organization_id = ? ORDER BY scope DESC, site_id`,
		[organizationId]
	);
	return results.map(toRow);
}

export async function getOrgBudget(
	db: CollegeDBClient,
	organizationId: string
): Promise<BudgetRow | null> {
	const row = await db.first<BudgetDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM budgets WHERE organization_id = ? AND scope = 'org'`,
		[organizationId]
	);
	return row ? toRow(row) : null;
}

export async function getSiteBudget(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<BudgetRow | null> {
	const row = await db.first<BudgetDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM budgets WHERE organization_id = ? AND scope = 'site' AND site_id = ?`,
		[organizationId, siteId]
	);
	return row ? toRow(row) : null;
}

// one organisation row and at most one row per site: the partial unique indexes decide which row an
// insert replaces
export async function putBudget(db: CollegeDBClient, row: BudgetRow): Promise<void> {
	const target =
		row.scope === 'org'
			? `(organization_id) WHERE scope = 'org'`
			: `(organization_id, site_id) WHERE scope = 'site'`;
	await db.run(
		row.organizationId,
		`INSERT INTO budgets (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT ${target} DO UPDATE SET percent = excluded.percent,
		 enforcement = excluded.enforcement, set_by = excluded.set_by, set_at = excluded.set_at`,
		[
			row.id,
			row.organizationId,
			row.scope,
			row.siteId,
			row.percent,
			row.enforcement,
			row.setBy,
			row.setAt
		]
	);
}

// true when this call created the organisation row; an existing row is the customer's choice and
// stays as it is
export async function seedOrgBudget(db: CollegeDBClient, row: BudgetRow): Promise<boolean> {
	const result = await db.run(
		row.organizationId,
		`INSERT INTO budgets (${COLUMNS}) VALUES (?, ?, 'org', NULL, ?, ?, ?, ?)
		 ON CONFLICT (organization_id) WHERE scope = 'org' DO NOTHING`,
		[row.id, row.organizationId, row.percent, row.enforcement, row.setBy, row.setAt]
	);
	return wasChanged(result);
}

// #endregion

// #region alerts sent

export interface AlertSentRow {
	organizationId: string;
	scopeKey: string;
	period: string;
	alertKey: string;
	sentAt: number;
}

interface AlertSentDb {
	organization_id: string;
	scope_key: string;
	period: string;
	alert_key: string;
	sent_at: number;
}

export const orgScopeKey = 'org';
export const siteScopeKey = (siteId: string): string => `site:${siteId}`;

export async function listAlertsSent(
	db: CollegeDBClient,
	organizationId: string,
	period: string
): Promise<AlertSentRow[]> {
	const { results } = await db.all<AlertSentDb>(
		organizationId,
		`SELECT organization_id, scope_key, period, alert_key, sent_at FROM budget_alerts_sent
		 WHERE organization_id = ? AND period = ? ORDER BY sent_at, scope_key, alert_key`,
		[organizationId, period]
	);
	return results.map((row) => ({
		organizationId: row.organization_id,
		scopeKey: row.scope_key,
		period: row.period,
		alertKey: row.alert_key,
		sentAt: row.sent_at
	}));
}

// false when the alert was already recorded for the period, so a restart never claims it twice
export async function recordAlertSent(db: CollegeDBClient, row: AlertSentRow): Promise<boolean> {
	const result = await db.run(
		row.organizationId,
		`INSERT INTO budget_alerts_sent (organization_id, scope_key, period, alert_key, sent_at)
		 VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
		[row.organizationId, row.scopeKey, row.period, row.alertKey, row.sentAt]
	);
	return wasChanged(result);
}

// gives the claim back when no recipient could be reached, so the next evaluation tries again
export async function releaseAlert(
	db: CollegeDBClient,
	row: Omit<AlertSentRow, 'sentAt'>
): Promise<void> {
	await db.run(
		row.organizationId,
		`DELETE FROM budget_alerts_sent
		 WHERE organization_id = ? AND scope_key = ? AND period = ? AND alert_key = ?`,
		[row.organizationId, row.scopeKey, row.period, row.alertKey]
	);
}

// #endregion

// #region budget source

// sites that can serve now, or are suspended and may serve again
export async function listBudgetSiteIds(
	db: CollegeDBClient,
	organizationId: string
): Promise<string[]> {
	const { results } = await db.all<{ id: string }>(
		organizationId,
		`SELECT id FROM sites
		 WHERE organization_id = ? AND ready_at IS NOT NULL AND state IN ('active', 'suspended')
		 ORDER BY id`,
		[organizationId]
	);
	return results.map((row) => row.id);
}

// a paid plan with a counted allowance has a budget; the free plan and an unknown or unlimited
// allowance have none, and the free-tier rules apply unchanged
export function budgetedViews(entitlement: Entitlement): number | null {
	if (managedIsFree(entitlement)) return null;
	return entitlement.views;
}

export function assembleOrganization(input: {
	organizationId: string;
	entitlement: Entitlement;
	rows: readonly BudgetRow[];
	siteIds: readonly string[];
}): OrgBudgetInput {
	const { organizationId, entitlement, rows, siteIds } = input;
	const views = budgetedViews(entitlement);
	const orgRow = rows.find((row) => row.scope === 'org') ?? null;
	const none: OrgBudgetInput = {
		orgId: organizationId,
		allowanceViews: null,
		budget: null,
		sites: siteIds.map((siteId) => ({ siteId, allowanceViews: null, budget: null }))
	};
	if (views === null || orgRow === null) return none;

	const pooled = entitlement.viewsPooled === true;
	const plan = findPlan(entitlement.managedPlanId);
	const orgBudget = { percent: orgRow.percent, enforcement: orgRow.enforcement };
	const siteRows = new Map(
		rows.filter((row) => row.scope === 'site').map((row) => [row.siteId, row])
	);
	const sites: SiteBudgetInput[] = siteIds.map((siteId) => {
		const row = siteRows.get(siteId);
		let budget: SiteBudgetInput['budget'] = null;
		if (row !== undefined) {
			budget = {
				percent: clampSiteToOrg(row.percent, orgRow.percent),
				enforcement: row.enforcement
			};
		} else if (pooled && plan !== undefined && siteIds.length > 1) {
			// until the owner sets one, a site under a pooled allowance takes the default share of the pool
			// and follows the organisation's enforcement
			budget = {
				percent: clampSiteToOrg(siteBudgetDefault(plan, siteIds.length), orgRow.percent),
				enforcement: orgRow.enforcement
			};
		}
		return { siteId, allowanceViews: views, budget };
	});
	return {
		orgId: organizationId,
		allowanceViews: pooled ? views : views * siteIds.length,
		budget: orgBudget,
		sites
	};
}

export function collegeBudgetSource(
	getDb: () => Promise<CollegeDBClient>,
	planOf: (organizationId: string) => Promise<Entitlement>
): BudgetSource {
	const load = async (db: CollegeDBClient, organizationId: string): Promise<OrgBudgetInput> =>
		assembleOrganization({
			organizationId,
			entitlement: await planOf(organizationId),
			rows: await listBudgetRows(db, organizationId),
			siteIds: await listBudgetSiteIds(db, organizationId)
		});
	return {
		async organizations() {
			const db = await getDb();
			const shards = await db.allAllShards<{ organization_id: string }>(
				`SELECT organization_id FROM budgets WHERE scope = 'org' ORDER BY organization_id`
			);
			const ids: string[] = [];
			for (const shard of shards) {
				if (!shard.success) throw new Error('a shard did not answer');
				ids.push(...shard.results.map((row) => row.organization_id));
			}
			return Promise.all(ids.map((id) => load(db, id)));
		},
		async organization(organizationId) {
			const db = await getDb();
			if ((await getOrgBudget(db, organizationId)) === null) return null;
			return load(db, organizationId);
		}
	};
}

// #endregion
