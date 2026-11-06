import { usageAdjustmentSchema, type UsageInterval } from '@contracts/usage';
import type { z } from 'zod';

export { enforcementViews } from '@contracts/usage';

export type UsageAdjustment = z.infer<typeof usageAdjustmentSchema>;

// inclusive view sequence numbers; a hole between batches is an acknowledgement gap
export interface ViewBatch {
	from: number;
	to: number;
}

export interface OpenInterval {
	siteId: UsageInterval['siteId'];
	start: UsageInterval['start'];
	end: UsageInterval['end'];
	observedViews: UsageInterval['observedViews'];
	settlement: 'open';
	issued: number;
	batches: readonly ViewBatch[];
	accountingAvailable: boolean;
}

export type SettledInterval = UsageInterval & {
	settlement: Exclude<UsageInterval['settlement'], 'open'>;
};

export type LedgerError =
	| 'not_ended'
	| 'bad_batch'
	| 'not_closed'
	| 'missing_ref'
	| 'not_invoiced'
	| 'bad_delta'
	| 'bad_reason'
	| 'bad_id'
	| 'bad_count'
	| 'bad_tolerance';

type Result<T> = ({ ok: true } & T) | { ok: false; reason: LedgerError };

const fail = (reason: LedgerError) => ({ ok: false as const, reason });

// an estimated interval bills its views; the lower bound is for free-tier enforcement and display
export type Billable =
	| { basis: 'exact'; views: number }
	| { basis: 'unaccounted'; views: 0 }
	| { basis: 'estimated'; views: number; lowerBound: number };

export function closeInterval(
	row: OpenInterval | SettledInterval,
	now: number
): Result<{ interval: UsageInterval }> {
	if (row.settlement !== 'open') return { ok: true, interval: row };
	if (now < Date.parse(row.end)) return fail('not_ended');

	const batches = [...row.batches].sort((a, b) => a.from - b.from);
	let acked = 0;
	let prevTo = 0;
	for (const b of batches) {
		if (b.from < 1 || b.to < b.from || b.to > row.issued || b.from <= prevTo) {
			return fail('bad_batch');
		}
		acked += b.to - b.from + 1;
		prevTo = b.to;
	}

	if (!row.accountingAvailable) {
		return {
			ok: true,
			interval: {
				siteId: row.siteId,
				start: row.start,
				end: row.end,
				accuracy: 'unaccounted',
				views: 0,
				lowerBound: 0,
				observedViews: row.observedViews,
				settlement: 'closed'
			}
		};
	}

	return {
		ok: true,
		interval: {
			siteId: row.siteId,
			start: row.start,
			end: row.end,
			accuracy: acked === row.issued ? 'exact' : 'estimated',
			views: row.issued,
			lowerBound: acked,
			observedViews: row.observedViews,
			settlement: 'closed'
		}
	};
}

export function billableViews(i: UsageInterval): Billable {
	if (i.accuracy === 'unaccounted') return { basis: 'unaccounted', views: 0 };
	if (i.accuracy === 'exact') return { basis: 'exact', views: i.views };
	return { basis: 'estimated', views: i.views, lowerBound: i.lowerBound };
}

export function settle(
	i: UsageInterval,
	invoiceRef: string
): Result<{ interval: UsageInterval; invoiceRef: string }> {
	if (i.settlement !== 'closed') return fail('not_closed');
	if (invoiceRef.trim() === '') return fail('missing_ref');
	return { ok: true, interval: { ...i, settlement: 'invoiced' }, invoiceRef };
}

export function adjust(
	i: UsageInterval,
	delta: number,
	reason: string,
	now: number,
	id: string
): Result<{ interval: UsageInterval; adjustment: UsageAdjustment }> {
	if (i.settlement !== 'invoiced' && i.settlement !== 'adjusted') return fail('not_invoiced');
	if (!Number.isInteger(delta) || delta === 0) return fail('bad_delta');
	if (reason.trim() === '' || reason.length > 500) return fail('bad_reason');
	if (id.length < 8 || id.length > 64) return fail('bad_id');
	return {
		ok: true,
		interval: { ...i, settlement: 'adjusted' },
		adjustment: {
			id,
			siteId: i.siteId,
			intervalStart: i.start,
			delta,
			reason,
			invoiceRef: null,
			at: new Date(now).toISOString()
		}
	};
}

export function meterEventId(i: Pick<UsageInterval, 'siteId' | 'start'>): string {
	return `usage:${i.siteId}:${i.start}`;
}

const isCount = (n: number) => Number.isInteger(n) && n >= 0;

export function reconcile(
	counter: number,
	provider: number,
	tolerance: number
): Result<{ status: 'within' | 'discrepancy'; delta: number }> {
	if (!isCount(counter) || !isCount(provider)) return fail('bad_count');
	if (!isCount(tolerance)) return fail('bad_tolerance');
	const delta = counter - provider;
	return { ok: true, status: Math.abs(delta) <= tolerance ? 'within' : 'discrepancy', delta };
}
