import { describe, expect, it } from 'vitest';
import {
	checkHeadroom,
	dryRunArguments,
	peakCalls,
	QuotaExhaustedError,
	RateLimitedError,
	readAccountUsage,
	retryAfterMsOf,
	USAGE_ERROR_CODES,
	UsageUnreadableError
} from '../../../engine/src/account-usage';
import type { CloudflareUsage } from '../../../engine/src/ports';
import { dryRun, planResources } from '../../../engine/src/provision-plan';
import { PermanentError } from '../../../engine/src/step';

const SITE = `site_${'s'.repeat(26)}`;
const plan = planResources({ id: SITE }, 'managed');

const reading = (over: Partial<CloudflareUsage> = {}): CloudflareUsage => ({
	kvNamespaces: 10,
	buckets: 3,
	rate: { remaining: 1000, resetSeconds: 120, quota: 1200, windowSeconds: 300 },
	...over
});

const tripped = new Set<string>();

function codeOf(work: () => unknown): string {
	try {
		work();
	} catch (error) {
		const { code } = error as { code: string };
		tripped.add(code);
		return code;
	}
	throw new Error('expected an error');
}

describe('readAccountUsage', () => {
	it('returns what the port read', async () => {
		const usage = reading();
		expect(await readAccountUsage({ readUsage: async () => usage })).toEqual(usage);
	});

	it('refuses a count that is not a whole non-negative number', async () => {
		for (const bad of [-1, 1.5, Number.NaN]) {
			const error = await readAccountUsage({
				readUsage: async () => reading({ kvNamespaces: bad })
			}).catch((caught) => caught);
			expect(error).toBeInstanceOf(UsageUnreadableError);
			tripped.add(error.code);
		}
		const buckets = await readAccountUsage({
			readUsage: async () => reading({ buckets: -2 })
		}).catch((caught) => caught);
		expect(buckets.message).toContain('bucket');
	});
});

describe('the dry run arguments', () => {
	const defaults = { kvNamespaces: 1000, requestsPerWindow: 1000, windowSeconds: 60 };

	it('use the response numbers where it gave them and the defaults where it did not', () => {
		const given = dryRunArguments(reading(), defaults);
		expect(given.usage).toEqual({ kvNamespaces: 10 });
		expect(given.limits).toEqual({
			kvNamespaces: 1000,
			requestsPerWindow: 1200,
			windowSeconds: 300
		});
		const silent = dryRunArguments(
			reading({
				rate: { remaining: null, resetSeconds: null, quota: null, windowSeconds: null }
			}),
			defaults
		);
		expect(silent.limits).toEqual(defaults);
	});

	it('feed the dry run, which prints the account numbers', () => {
		const { limits, usage } = dryRunArguments(reading(), defaults);
		const text = dryRun(plan, limits, usage);
		expect(text).toContain('KV namespaces: 2 added to 10, 12 of 1,000, within the limit.');
		expect(text).toContain('requests per 5 minutes');
	});
});

describe('checkHeadroom', () => {
	it('passes when the window and the namespace count both have room', () => {
		expect(() =>
			checkHeadroom(plan, reading(), { kvNamespaces: 1000, buckets: 100 })
		).not.toThrow();
		expect(() => checkHeadroom(plan, reading(), undefined)).not.toThrow();
	});

	it('counts a lookup and a create per resource, plus the rollback deletes', () => {
		expect(peakCalls(plan)).toBe(plan.create.length * 3);
	});

	it('fails as a retryable rate limit that names the wait', () => {
		const slow = reading({
			rate: {
				remaining: peakCalls(plan) - 1,
				resetSeconds: 90,
				quota: 1200,
				windowSeconds: 300
			}
		});
		let caught: unknown;
		try {
			checkHeadroom(plan, slow, undefined);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(RateLimitedError);
		expect(caught).not.toBeInstanceOf(PermanentError);
		expect(retryAfterMsOf(caught)).toBe(90_000);
		tripped.add((caught as RateLimitedError).code);
	});

	it('passes at exactly the number of calls it needs', () => {
		const exact = reading({
			rate: { remaining: peakCalls(plan), resetSeconds: 90, quota: 1200, windowSeconds: 300 }
		});
		expect(() => checkHeadroom(plan, exact, undefined)).not.toThrow();
	});

	it('does not name a wait when the response gave none', () => {
		const silent = reading({
			rate: { remaining: 0, resetSeconds: null, quota: null, windowSeconds: null }
		});
		try {
			checkHeadroom(plan, silent, undefined);
		} catch (error) {
			expect(retryAfterMsOf(error)).toBeNull();
		}
	});

	it('fails as a retryable quota when the namespaces or buckets would pass the limit', () => {
		expect(
			codeOf(() =>
				checkHeadroom(plan, reading({ kvNamespaces: 999 }), { kvNamespaces: 1000 })
			)
		).toBe('quota_exhausted');
		expect(
			codeOf(() =>
				checkHeadroom(plan, reading({ buckets: 9 }), { kvNamespaces: 1000, buckets: 10 })
			)
		).toBe('quota_exhausted');
		expect(() =>
			checkHeadroom(plan, reading({ kvNamespaces: 998 }), { kvNamespaces: 1000 })
		).not.toThrow();
		const error = new QuotaExhaustedError('kv', 1, 2, 3);
		expect(error).not.toBeInstanceOf(PermanentError);
		expect(retryAfterMsOf(error)).toBeNull();
		expect(retryAfterMsOf(new Error('x'))).toBeNull();
	});
});

describe('every typed usage error', () => {
	it('was tripped once', () => {
		expect([...tripped].sort()).toEqual([...USAGE_ERROR_CODES].sort());
	});
});
