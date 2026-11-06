import { describe, expect, it } from 'vitest';
import { newId } from '../../../contracts/src/common';
import {
	enforcementViews,
	usageAdjustmentSchema,
	usageIntervalSchema,
	type UsageInterval
} from '../../../contracts/src/usage';
import {
	adjust,
	billableViews,
	closeInterval,
	enforcementViews as ledgerEnforcementViews,
	meterEventId,
	reconcile,
	settle,
	type OpenInterval,
	type SettledInterval,
	type ViewBatch
} from '../../../src/server/domain/usage-ledger';

const siteId = newId('site') as UsageInterval['siteId'];
const START = '2026-11-05T12:00:00.000Z';
const END = '2026-11-05T13:00:00.000Z';
const END_MS = Date.parse(END);
const ISSUED = 5;

function open(over: Partial<OpenInterval> = {}): OpenInterval {
	return {
		siteId,
		start: START,
		end: END,
		observedViews: null,
		settlement: 'open',
		issued: 10,
		batches: [{ from: 1, to: 10 }],
		accountingAvailable: true,
		...over
	};
}

function closed(over: Partial<OpenInterval> = {}): SettledInterval {
	const r = closeInterval(open(over), END_MS);
	if (!r.ok) throw new Error(r.reason);
	return r.interval as SettledInterval;
}

function interval(over: Partial<UsageInterval> = {}): UsageInterval {
	return { ...closed(), ...over } as UsageInterval;
}

function invoice(i: UsageInterval): UsageInterval {
	const r = settle(i, 'inv_1');
	if (!r.ok) throw new Error(r.reason);
	return r.interval;
}

// every acknowledgement pattern over ISSUED views, as maximal runs
function patterns(): { seqs: number[]; batches: ViewBatch[] }[] {
	const out: { seqs: number[]; batches: ViewBatch[] }[] = [];
	for (let mask = 0; mask < 1 << ISSUED; mask++) {
		const seqs = Array.from({ length: ISSUED }, (_, i) => i + 1).filter(
			(seq) => (mask & (1 << (seq - 1))) !== 0
		);
		const batches: ViewBatch[] = [];
		for (const seq of seqs) {
			const last = batches[batches.length - 1];
			if (last && last.to + 1 === seq) last.to = seq;
			else batches.push({ from: seq, to: seq });
		}
		out.push({ seqs, batches });
	}
	return out;
}

describe('closeInterval', () => {
	it('is exact when every acknowledged batch is contiguous and covers the issued views', () => {
		const r = closeInterval(
			open({
				batches: [
					{ from: 1, to: 4 },
					{ from: 5, to: 10 }
				]
			}),
			END_MS
		);
		if (!r.ok) throw new Error(r.reason);
		expect(usageIntervalSchema.parse(r.interval)).toEqual({
			siteId,
			start: START,
			end: END,
			accuracy: 'exact',
			views: 10,
			lowerBound: 10,
			observedViews: null,
			settlement: 'closed'
		});
	});

	it('reads batches in any order', () => {
		const r = closeInterval(
			open({
				batches: [
					{ from: 5, to: 10 },
					{ from: 1, to: 4 }
				]
			}),
			END_MS
		);
		if (!r.ok) throw new Error(r.reason);
		expect(r.interval).toMatchObject({ accuracy: 'exact', lowerBound: 10 });
	});

	it('is estimated when a gap sits between acknowledged batches', () => {
		const r = closeInterval(
			open({
				batches: [
					{ from: 1, to: 4 },
					{ from: 7, to: 10 }
				]
			}),
			END_MS
		);
		if (!r.ok) throw new Error(r.reason);
		expect(r.interval).toMatchObject({ accuracy: 'estimated', views: 10, lowerBound: 8 });
	});

	it('is estimated when the last views of the hour were never acknowledged', () => {
		const r = closeInterval(open({ batches: [{ from: 1, to: 6 }] }), END_MS);
		if (!r.ok) throw new Error(r.reason);
		expect(r.interval).toMatchObject({ accuracy: 'estimated', views: 10, lowerBound: 6 });
	});

	it('is unaccounted when accounting was unavailable for the hour', () => {
		const r = closeInterval(
			open({ accountingAvailable: false, batches: [], issued: 0 }),
			END_MS
		);
		if (!r.ok) throw new Error(r.reason);
		expect(r.interval).toMatchObject({ accuracy: 'unaccounted', views: 0, lowerBound: 0 });
	});

	it('is exact with zero views when nothing was issued', () => {
		const r = closeInterval(open({ batches: [], issued: 0 }), END_MS);
		if (!r.ok) throw new Error(r.reason);
		expect(r.interval).toMatchObject({ accuracy: 'exact', views: 0, lowerBound: 0 });
	});

	it('classifies every acknowledgement pattern as exact only when all views are acknowledged', () => {
		for (const { seqs, batches } of patterns()) {
			const r = closeInterval(open({ issued: ISSUED, batches }), END_MS);
			if (!r.ok) throw new Error(r.reason);
			expect(usageIntervalSchema.safeParse(r.interval).success).toBe(true);
			expect(r.interval).toMatchObject({
				accuracy: seqs.length === ISSUED ? 'exact' : 'estimated',
				views: ISSUED,
				lowerBound: seqs.length
			});
		}
	});

	it('is idempotent: closing a closed interval returns it unchanged', () => {
		const first = closeInterval(open(), END_MS);
		if (!first.ok) throw new Error(first.reason);
		expect(closeInterval(first.interval as SettledInterval, END_MS + 60_000)).toEqual({
			ok: true,
			interval: first.interval
		});
	});

	it('leaves an invoiced interval unchanged', () => {
		const invoiced = invoice(interval());
		expect(closeInterval(invoiced as SettledInterval, END_MS)).toEqual({
			ok: true,
			interval: invoiced
		});
	});

	it('refuses to close before the hour ends', () => {
		expect(closeInterval(open(), END_MS - 1)).toEqual({ ok: false, reason: 'not_ended' });
		expect(closeInterval(open(), END_MS).ok).toBe(true);
	});

	it.each([
		['a batch starting below 1', [{ from: 0, to: 4 }]],
		['a batch ending before it starts', [{ from: 3, to: 2 }]],
		['a batch past the issued views', [{ from: 1, to: 11 }]],
		[
			'overlapping batches',
			[
				{ from: 1, to: 5 },
				{ from: 5, to: 10 }
			]
		]
	])('refuses %s', (_, batches) => {
		expect(closeInterval(open({ batches }), END_MS)).toEqual({
			ok: false,
			reason: 'bad_batch'
		});
	});
});

describe('billableViews', () => {
	it('bills unaccounted intervals at zero whatever was observed', () => {
		const i = interval({ accuracy: 'unaccounted', views: 0, lowerBound: 0, observedViews: 50 });
		expect(billableViews(i)).toEqual({ basis: 'unaccounted', views: 0 });
	});

	it('bills an exact interval at its counted value', () => {
		expect(billableViews(interval({ accuracy: 'exact', views: 7, lowerBound: 7 }))).toEqual({
			basis: 'exact',
			views: 7
		});
	});

	it('bills an estimated interval at its estimate and keeps the lower bound for display, never a bare number', () => {
		const result = billableViews(interval({ accuracy: 'estimated', views: 10, lowerBound: 8 }));
		expect(result).toEqual({ basis: 'estimated', views: 10, lowerBound: 8 });
		expect(result.views).toBeGreaterThan(8);
		expect(result.basis).not.toBe('exact');
	});
});

describe('enforcementViews', () => {
	it('is the contract function, re-exported', () => {
		expect(ledgerEnforcementViews).toBe(enforcementViews);
	});

	it('never exceeds the billable count and is the lower bound for estimates', () => {
		for (const { batches } of patterns()) {
			const r = closeInterval(open({ issued: ISSUED, batches }), END_MS);
			if (!r.ok) throw new Error(r.reason);
			const billable = billableViews(r.interval);
			expect(ledgerEnforcementViews(r.interval)).toBeLessThanOrEqual(billable.views);
			if (billable.basis === 'estimated') {
				expect(ledgerEnforcementViews(r.interval)).toBe(billable.lowerBound);
			}
		}
	});

	it('counts an unaccounted interval as zero', () => {
		const i = interval({ accuracy: 'unaccounted', views: 0, lowerBound: 0 });
		expect(ledgerEnforcementViews(i)).toBe(0);
	});
});

describe('settle', () => {
	it('moves a closed interval to invoiced with its reference and leaves the counts alone', () => {
		const before = interval({ accuracy: 'estimated', views: 10, lowerBound: 8 });
		const r = settle(before, 'inv_0001');
		expect(r).toEqual({
			ok: true,
			interval: { ...before, settlement: 'invoiced' },
			invoiceRef: 'inv_0001'
		});
	});

	it('refuses an open interval', () => {
		expect(settle(interval({ settlement: 'open' }), 'inv_0001')).toEqual({
			ok: false,
			reason: 'not_closed'
		});
	});

	it('refuses an interval that is already invoiced', () => {
		const invoiced = invoice(interval());
		expect(settle(invoiced, 'inv_0002')).toEqual({ ok: false, reason: 'not_closed' });
	});

	it.each(['', '   '])('refuses a blank invoice reference (%j)', (ref) => {
		expect(settle(interval(), ref)).toEqual({ ok: false, reason: 'missing_ref' });
	});
});

describe('adjust', () => {
	const id = 'adj_000000001';
	const NOW = END_MS + 3 * 3_600_000;

	it('writes an adjustment record, moves the interval to adjusted and keeps the original counts', () => {
		const invoiced = invoice(interval({ accuracy: 'estimated', views: 10, lowerBound: 8 }));
		const r = adjust(invoiced, -3, 'duplicate tag fire', NOW, id);
		if (!r.ok) throw new Error(r.reason);
		expect(usageAdjustmentSchema.parse(r.adjustment)).toEqual({
			id,
			siteId,
			intervalStart: START,
			delta: -3,
			reason: 'duplicate tag fire',
			invoiceRef: null,
			at: new Date(NOW).toISOString()
		});
		expect(r.interval).toEqual({ ...invoiced, settlement: 'adjusted' });
	});

	it('accepts a second adjustment on an adjusted interval and keeps it adjusted', () => {
		const first = adjust(invoice(interval()), -3, 'reason one', NOW, id);
		if (!first.ok) throw new Error(first.reason);
		const second = adjust(first.interval, 1, 'reason two', NOW, 'adj_000000002');
		if (!second.ok) throw new Error(second.reason);
		expect(second.interval.settlement).toBe('adjusted');
	});

	it('leaves the invoiced counts frozen across adjustments', () => {
		const invoiced = invoice(interval());
		const a = adjust(invoiced, -3, 'reason one', NOW, id);
		if (!a.ok) throw new Error(a.reason);
		const b = adjust(a.interval, 2, 'reason two', NOW, 'adj_000000002');
		if (!b.ok) throw new Error(b.reason);
		expect(billableViews(b.interval)).toEqual(billableViews(invoiced));
		expect(b.interval).toMatchObject({
			views: invoiced.views,
			lowerBound: invoiced.lowerBound
		});
		expect([a.adjustment.delta, b.adjustment.delta]).toEqual([-3, 2]);
	});

	it.each([
		['an open interval', () => interval({ settlement: 'open' })],
		['a closed interval', () => interval({ settlement: 'closed' })]
	])('refuses %s', (_, make) => {
		expect(adjust(make(), 1, 'reason', NOW, id)).toEqual({ ok: false, reason: 'not_invoiced' });
	});

	it.each([0, 1.5])('refuses a delta of %s', (delta) => {
		expect(adjust(invoice(interval()), delta, 'reason', NOW, id)).toEqual({
			ok: false,
			reason: 'bad_delta'
		});
	});

	it.each(['', '   ', 'x'.repeat(501)])('refuses a reason of length %j', (reason) => {
		expect(adjust(invoice(interval()), 1, reason, NOW, id)).toEqual({
			ok: false,
			reason: 'bad_reason'
		});
	});

	it('refuses an id outside the contract length', () => {
		expect(adjust(invoice(interval()), 1, 'reason', NOW, 'short')).toEqual({
			ok: false,
			reason: 'bad_id'
		});
	});
});

describe('meterEventId', () => {
	it('gives two retries of one interval the same id, whatever state it is in', () => {
		const i = interval();
		const first = meterEventId(i);
		expect(meterEventId(i)).toBe(first);
		expect(meterEventId(invoice(i))).toBe(first);
	});

	it('gives distinct intervals distinct ids', () => {
		const other = { ...interval(), start: '2026-11-05T13:00:00.000Z' };
		expect(meterEventId(other)).not.toBe(meterEventId(interval()));
		expect(
			meterEventId({ ...interval(), siteId: newId('site') as UsageInterval['siteId'] })
		).not.toBe(meterEventId(interval()));
	});
});

describe('reconcile', () => {
	it('reports within when the difference is inside the tolerance, boundary included', () => {
		expect(reconcile(100, 100, 0)).toEqual({ ok: true, status: 'within', delta: 0 });
		expect(reconcile(103, 100, 3)).toEqual({ ok: true, status: 'within', delta: 3 });
	});

	it('reports the sign and size of a discrepancy', () => {
		expect(reconcile(97, 100, 2)).toEqual({ ok: true, status: 'discrepancy', delta: -3 });
		expect(reconcile(105, 100, 2)).toEqual({ ok: true, status: 'discrepancy', delta: 5 });
	});

	it.each([
		['a negative counter', [-1, 100, 0]],
		['a fractional provider figure', [100, 1.5, 0]]
	] as const)('refuses %s', (_, [counter, provider, tolerance]) => {
		expect(reconcile(counter, provider, tolerance)).toEqual({ ok: false, reason: 'bad_count' });
	});

	it('refuses a negative tolerance', () => {
		expect(reconcile(100, 100, -1)).toEqual({ ok: false, reason: 'bad_tolerance' });
	});
});
