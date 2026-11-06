import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { siteId } from '../../../contracts/src/common';
import {
	HOUR_MS,
	applyIn,
	createAccounting,
	mechanism,
	readHourIn,
	type ApplyAnswer,
	type CountWrite
} from '../../../dispatch/src/counting';
import {
	ARMS,
	DEFAULTS,
	PRICE_NAMES,
	added,
	armRow,
	callsPerTrial,
	checkApply,
	checkParams,
	controlSiteId,
	counted,
	discrepancy,
	estimate,
	hostFor,
	hybridLimit,
	isTerminationTrial,
	parsePriceSheet,
	parseReadout,
	siteIdFor,
	type Arm,
	type Params
} from '../../../scripts/spikes/counting/plan';
import { fakeClock, memoryKv } from './fakes';

const HOUR0 = Date.UTC(2026, 10, 6, 12);
const SITE = 'site_plansim000001';

// one isolate counting one site at a steady rate against a counter that always answers
async function simulate(arm: Arm, p: Params) {
	const kv = memoryKv();
	const clock = fakeClock(HOUR0 + 1000);
	const pending: Promise<unknown>[] = [];
	let calls = 0;
	const accounting = createAccounting({
		counting: mechanism(arm, { batchSize: p.batchSize, flushMs: p.flushMs }),
		origin: 'originone01',
		now: clock.now,
		send: async (write: CountWrite): Promise<ApplyAnswer> => {
			calls++;
			return applyIn(kv, write, clock.now(), SITE);
		},
		waitUntil: (promise) => void pending.push(promise)
	});
	const limit = arm === 'hybrid' ? hybridLimit(p) : null;
	const step = 1000 / p.rate;
	for (let i = 0; i < p.requestsPerTrial; i++) {
		clock.advance(step);
		await accounting.count({ siteId: SITE, status: 200, contentType: 'text/html', limit });
		await Promise.all(pending.splice(0));
	}
	for (let i = 0; i < 4; i++) {
		clock.advance(p.flushMs + 1);
		accounting.tick();
		await Promise.all(pending.splice(0));
	}
	const hour = readHourIn(kv, SITE, HOUR0);
	return { calls, acked: counted([hour]).acked, issued: counted([hour]).issued };
}

describe('the dry-run arithmetic', () => {
	const cases: Params[] = [
		{ ...DEFAULTS },
		{ ...DEFAULTS, rate: 5, requestsPerTrial: 200 },
		{
			...DEFAULTS,
			rate: 10,
			requestsPerTrial: 101,
			batchSize: 7,
			flushMs: 1000,
			hybridLimitFraction: 0.5
		},
		{
			...DEFAULTS,
			rate: 2,
			requestsPerTrial: 61,
			batchSize: 100,
			flushMs: 3000,
			hybridLimitFraction: 0.75
		}
	];

	for (const p of cases) {
		for (const arm of ARMS) {
			it(`matches the code for ${arm} at ${p.rate} a second, ${p.requestsPerTrial} requests, batch ${p.batchSize}`, async () => {
				const run = await simulate(arm, p);
				expect(run.calls).toBe(callsPerTrial(arm, p));
				expect(run.acked).toBe(p.requestsPerTrial);
				expect(run.issued).toBe(p.requestsPerTrial);
			});
		}
	}

	it('counts the same sites and requests in every arm, and puts the hybrid between the ends', () => {
		const rows = ARMS.map((arm) => armRow(arm, DEFAULTS));
		for (const row of rows) {
			expect(row.sites).toBe(DEFAULTS.trialsPerArm);
			expect(row.requests).toBe(DEFAULTS.trialsPerArm * DEFAULTS.requestsPerTrial);
			expect(row.rowsWritten).toBe(row.counterCalls * 2);
		}
		const [writeThrough, batched, hybrid] = rows;
		expect(batched?.counterCalls).toBeLessThan(hybrid?.counterCalls ?? 0);
		expect(hybrid?.counterCalls).toBeLessThan(writeThrough?.counterCalls ?? 0);
	});

	it('adds up the arms and the control, and prices a smaller run lower', () => {
		const full = estimate(DEFAULTS, null);
		const small = estimate({ ...DEFAULTS, trialsPerArm: 2 }, null);
		expect(full.totalCounterCalls).toBe(full.arms.reduce((n, row) => n + row.counterCalls, 0));
		expect(full.totalRequests).toBe(
			full.arms.reduce((n, row) => n + row.requests, 0) + full.controlRequests
		);
		expect(small.totalObjectRequests).toBeLessThan(full.totalObjectRequests);
		expect(full.cost).toBeNull();
	});
});

describe('the price sheet', () => {
	const file = JSON.parse(readFileSync('scripts/spikes/counting/prices.json', 'utf8'));

	it('reads the committed sheet and names where and when each price was read', () => {
		const sheet = parsePriceSheet(file);
		expect(sheet.ok).toBe(true);
		if (!sheet.ok) return;
		for (const name of PRICE_NAMES) {
			expect(sheet.sheet[name].page).not.toBe('');
			expect(sheet.sheet[name].fetched).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it('refuses a sheet with a price missing, a bad number or no source', () => {
		for (const name of PRICE_NAMES) {
			expect(parsePriceSheet({ ...file, [name]: undefined })).toEqual({
				ok: false,
				reason: `${name} is missing`
			});
			expect(
				parsePriceSheet({ ...file, [name]: { ...file[name], usdPerMillion: -1 } })
			).toMatchObject({
				ok: false
			});
			expect(
				parsePriceSheet({ ...file, [name]: { ...file[name], includedPerMonth: 'x' } })
			).toMatchObject({
				ok: false
			});
			for (const field of ['page', 'fetched', 'read']) {
				const result = parsePriceSheet({ ...file, [name]: { ...file[name], [field]: '' } });
				expect(result).toEqual({
					ok: false,
					reason: `${name}.${field} must say where and when the price was read`
				});
			}
		}
		expect(parsePriceSheet(null)).toMatchObject({ ok: false });
		expect(parsePriceSheet('x')).toMatchObject({ ok: false });
	});

	it('charges the whole use at list price and only the part above the included use as marginal', () => {
		const parsed = parsePriceSheet(file);
		if (!parsed.ok) throw new Error(parsed.reason);
		const small = estimate(DEFAULTS, parsed.sheet);
		expect(small.cost?.marginalUsd).toBe(0);
		expect(small.cost?.grossUsd).toBeGreaterThan(0);
		const sum = PRICE_NAMES.reduce((n, name) => n + (small.cost?.lines[name] ?? 0), 0);
		expect(small.cost?.grossUsd).toBeCloseTo(sum, 12);
		const big = estimate({ ...DEFAULTS, trialsPerArm: 1000 }, parsed.sheet);
		expect(big.cost?.marginalUsd).toBeGreaterThan(0);
		expect(big.cost?.marginalUsd).toBeLessThan(big.cost?.grossUsd ?? 0);
	});
});

describe('parameters', () => {
	it('accepts the defaults and names the first bad value', () => {
		expect(checkParams(DEFAULTS)).toBeNull();
		expect(checkParams({ ...DEFAULTS, rate: 0 })).toBe('rate must be a positive number');
		expect(checkParams({ ...DEFAULTS, rate: Number.NaN })).toBe(
			'rate must be a positive number'
		);
		expect(checkParams({ ...DEFAULTS, batchSize: 1.5 })).toBe(
			'batchSize must be a whole number'
		);
		expect(checkParams({ ...DEFAULTS, hybridLimitFraction: 1 })).toBe(
			'hybridLimitFraction must be below 1'
		);
		expect(checkParams({ ...DEFAULTS, requestsPerTrial: 4, hybridLimitFraction: 0.5 })).toBe(
			'the hybrid limit must be at least 3 views'
		);
	});
});

describe('trial naming', () => {
	it('gives each trial one site id the contract accepts, and one host', () => {
		const ids = new Set<string>();
		for (const arm of ARMS) {
			for (let n = 0; n < 10; n++) {
				const id = siteIdFor('r1', arm, n);
				expect(siteId.safeParse(id).success).toBe(true);
				ids.add(id);
			}
		}
		ids.add(controlSiteId('r1'));
		expect(ids.size).toBe(31);
		expect(siteId.safeParse(controlSiteId('r1')).success).toBe(true);
		expect(siteIdFor('r2', 'hybrid', 0)).not.toBe(siteIdFor('r1', 'hybrid', 0));
		expect(hostFor('{arm}-{n}.x.example', 'batched', 3)).toBe('batched-3.x.example');
	});

	it('ends an isolate in every other trial', () => {
		expect(Array.from({ length: 6 }, (_, n) => isTerminationTrial(n))).toEqual([
			false,
			true,
			false,
			true,
			false,
			true
		]);
	});
});

describe('reading helpers', () => {
	it('takes the control away from the trial at p50 and p95, and says null for nothing', () => {
		const trial = [10, 12, 14, 16, 100];
		const control = [5, 6, 7, 8, 9];
		expect(added(trial, control)).toEqual({ p50: 7, p95: 91 });
		expect(added([], control)).toEqual({ p50: null, p95: null });
		expect(added(trial, [])).toEqual({ p50: null, p95: null });
	});

	const hour = (issued: number, acked: number, origins = 1, available = true) => ({
		siteId: SITE,
		start: new Date(HOUR0).toISOString(),
		end: new Date(HOUR0 + HOUR_MS).toISOString(),
		observedViews: null,
		settlement: 'open' as const,
		issued,
		batches: acked > 0 ? [{ from: 1, to: acked }] : [],
		accountingAvailable: available,
		origins
	});

	it('sums the hours of a trial and reads a missing hour as nothing', () => {
		expect(counted([hour(10, 8, 1), null, hour(5, 5, 2, false)])).toEqual({
			acked: 13,
			issued: 15,
			origins: 2,
			available: false
		});
		expect(counted([null])).toEqual({ acked: 0, issued: 0, origins: 0, available: true });
	});

	it('signs the discrepancy: positive is more than the tenant served', () => {
		expect(discrepancy({ acked: 95, issued: 100 }, 100)).toEqual({ acked: -5, issued: 0 });
		expect(discrepancy({ acked: 103, issued: 103 }, 100)).toEqual({ acked: 3, issued: 3 });
	});

	it('accepts a well-formed readout and names what is wrong with a bad one', () => {
		const counts = {
			since: 1,
			calls: 2,
			refused: 0,
			puts: 4,
			appliedViews: 5,
			duplicateViews: 0
		};
		expect(parseReadout({ counts, hours: [hour(1, 1), null] }).ok).toBe(true);
		expect(parseReadout(null)).toMatchObject({ ok: false });
		expect(parseReadout({ hours: [] })).toEqual({ ok: false, reason: 'counts is missing' });
		expect(parseReadout({ counts: { ...counts, puts: 'x' }, hours: [] })).toEqual({
			ok: false,
			reason: 'counts.puts must be a number'
		});
		expect(parseReadout({ counts, hours: 'x' })).toEqual({
			ok: false,
			reason: 'hours must be a list'
		});
		expect(parseReadout({ counts, hours: [{}] })).toEqual({
			ok: false,
			reason: 'an hour is neither null nor a counted hour'
		});
	});
});

describe('apply guard', () => {
	const all = [
		'--apply',
		'--host-template',
		'{n}.x.example',
		'--control-url',
		'https://c.example',
		'--off-host',
		'off.example',
		'--read-url',
		'https://r.example',
		'--evict-url',
		'https://e.example',
		'--prices',
		'prices.json'
	];
	const env = { SPIKE_CONFIRM: '1', SPIKE_CONTROL_SEED: 's' };

	it('lets a dry run through and refuses --apply without the confirmation', () => {
		expect(checkApply([], {})).toEqual({ ok: true });
		expect(checkApply(all, {})).toMatchObject({ ok: false });
		expect(checkApply(all, { ...env, SPIKE_CONFIRM: '0' })).toMatchObject({ ok: false });
	});

	it('refuses --apply without each flag and each secret', () => {
		expect(checkApply(all, env)).toEqual({ ok: true });
		for (const flag of [
			'--host-template',
			'--control-url',
			'--off-host',
			'--read-url',
			'--evict-url',
			'--prices'
		]) {
			const at = all.indexOf(flag);
			const without = all.filter((_, i) => i !== at && i !== at + 1);
			expect(checkApply(without, env)).toEqual({
				ok: false,
				reason: `--apply needs ${flag}`
			});
		}
		expect(checkApply(all, { ...env, SPIKE_CONTROL_SEED: undefined })).toEqual({
			ok: false,
			reason: '--apply needs SPIKE_CONTROL_SEED'
		});
	});
});
