import { describe, expect, it } from 'vitest';
import { rateLimitHeaders, slideWindow } from '../../../../src/server/utils/rate-limit';

const pair = { limit: 2, windowMs: 1000 };
const minute = { limit: 2, windowMs: 60_000 };

describe('slideWindow', () => {
	it('allows requests up to the limit and denies the next', () => {
		const first = slideWindow([], 0, pair);
		expect(first).toMatchObject({ allowed: true, remaining: 1 });

		const second = slideWindow(first.timestamps, 0, pair);
		expect(second).toMatchObject({ allowed: true, remaining: 0 });

		const third = slideWindow(second.timestamps, 0, pair);
		expect(third).toMatchObject({ allowed: false, remaining: 0 });
	});

	it('keeps a request counted one millisecond before it expires', () => {
		expect(slideWindow([0, 0], 999, pair)).toMatchObject({ allowed: false });
	});

	it('frees the slots exactly at expiry', () => {
		const allowed = slideWindow([0, 0], 1000, pair);
		expect(allowed).toMatchObject({ allowed: true, remaining: 1 });
		expect(allowed.timestamps).toEqual([1000]);
	});

	it('gives the seconds until the oldest request leaves the window, rounded up', () => {
		expect(slideWindow([0, 30_000], 45_000, minute)).toMatchObject({
			allowed: false,
			retryAfterSeconds: 15,
			resetSeconds: 15
		});
		expect(slideWindow([0, 30_000], 45_500, minute)).toMatchObject({
			retryAfterSeconds: 15
		});
	});

	it('gives no retry delay when allowed and a full window reset after one request', () => {
		expect(slideWindow([], 0, minute)).toMatchObject({
			allowed: true,
			retryAfterSeconds: 0,
			resetSeconds: 60
		});
	});
});

describe('rateLimitHeaders', () => {
	it('sends the quota headers without Retry-After when allowed', () => {
		expect(rateLimitHeaders(slideWindow([], 0, minute))).toEqual({
			'RateLimit-Limit': '2',
			'RateLimit-Remaining': '1',
			'RateLimit-Reset': '60'
		});
	});

	it('adds Retry-After when denied', () => {
		expect(rateLimitHeaders(slideWindow([0, 30_000], 45_500, minute))).toEqual({
			'RateLimit-Limit': '2',
			'RateLimit-Remaining': '0',
			'RateLimit-Reset': '15',
			'Retry-After': '15'
		});
	});
});
