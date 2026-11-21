import type { CollegeDBClient } from '@earth-app/collegedb';

export type AccountingState = 'exact' | 'estimated' | 'unaccounted';
export type SettlementState = 'open' | 'closed' | 'invoiced' | 'adjusted';

// hour_start is the ISO start of the UTC hour; issued and acked are the counter's figures, and
// both are zero for an unaccounted hour
export interface IntervalRow {
	organizationId: string;
	siteId: string;
	hourStart: string;
	issued: number;
	acked: number;
	accounting: AccountingState;
	settlement: SettlementState;
	invoiceRef: string | null;
	closedAt: number | null;
}

export interface AdjustmentRow {
	id: string;
	organizationId: string;
	siteId: string;
	intervalStart: string;
	delta: number;
	reason: string;
	invoiceRef: string | null;
	setBy: string;
	at: number;
}

interface IntervalDb {
	organization_id: string;
	site_id: string;
	hour_start: string;
	issued: number;
	acked: number;
	accounting: AccountingState;
	settlement: SettlementState;
	invoice_ref: string | null;
	closed_at: number | null;
}

const COLUMNS =
	'organization_id, site_id, hour_start, issued, acked, accounting, settlement, invoice_ref, closed_at';

// a bound list stays well under the D1 parameter limit
const SITE_CHUNK = 50;

function toRow(row: IntervalDb): IntervalRow {
	return {
		organizationId: row.organization_id,
		siteId: row.site_id,
		hourStart: row.hour_start,
		issued: row.issued,
		acked: row.acked,
		accounting: row.accounting,
		settlement: row.settlement,
		invoiceRef: row.invoice_ref,
		closedAt: row.closed_at
	};
}

export async function listOpenIntervals(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	fromHour: string
): Promise<IntervalRow[]> {
	const { results } = await db.all<IntervalDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM usage_intervals
		 WHERE organization_id = ? AND site_id = ? AND settlement = 'open' AND hour_start >= ?
		 ORDER BY hour_start`,
		[organizationId, siteId, fromHour]
	);
	return results.map(toRow);
}

// only managed sites are counted by the dispatch Worker; another plane's traffic is not on the counter
export async function listManagedSites(
	db: CollegeDBClient
): Promise<{ id: string; organizationId: string }[]> {
	const shards = await db.allAllShards<{ id: string; organization_id: string }>(
		`SELECT id, organization_id FROM sites WHERE state = 'active' AND plane = 'managed' ORDER BY id`,
		[]
	);
	return shards.flatMap((shard) => {
		if (!shard.success) throw new Error('a shard could not list its managed sites');
		return shard.results.map((row) => ({ id: row.id, organizationId: row.organization_id }));
	});
}

// a row is only written while it is open, so a closed, invoiced or adjusted hour is never rewritten
export async function upsertInterval(db: CollegeDBClient, row: IntervalRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO usage_intervals (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (site_id, hour_start) DO UPDATE SET
		   issued = excluded.issued,
		   acked = excluded.acked,
		   accounting = excluded.accounting,
		   settlement = excluded.settlement,
		   closed_at = excluded.closed_at
		 WHERE usage_intervals.settlement = 'open'`,
		[
			row.organizationId,
			row.siteId,
			row.hourStart,
			row.issued,
			row.acked,
			row.accounting,
			row.settlement,
			row.invoiceRef,
			row.closedAt
		]
	);
}

// the hours of the given sites from `fromHour` up to, not including, `toHour`
export async function listIntervals(
	db: CollegeDBClient,
	organizationId: string,
	siteIds: readonly string[],
	fromHour: string,
	toHour: string
): Promise<IntervalRow[]> {
	const out: IntervalRow[] = [];
	for (let i = 0; i < siteIds.length; i += SITE_CHUNK) {
		const chunk = siteIds.slice(i, i + SITE_CHUNK);
		const marks = chunk.map(() => '?').join(', ');
		const { results } = await db.all<IntervalDb>(
			organizationId,
			`SELECT ${COLUMNS} FROM usage_intervals
			 WHERE organization_id = ? AND site_id IN (${marks}) AND hour_start >= ? AND hour_start < ?
			 ORDER BY site_id, hour_start`,
			[organizationId, ...chunk, fromHour, toHour]
		);
		out.push(...results.map(toRow));
	}
	return out;
}

export async function insertAdjustment(db: CollegeDBClient, row: AdjustmentRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO usage_adjustments (id, organization_id, site_id, interval_start, delta, reason, invoice_ref, set_by, at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.organizationId,
			row.siteId,
			row.intervalStart,
			row.delta,
			row.reason,
			row.invoiceRef,
			row.setBy,
			row.at
		]
	);
}
