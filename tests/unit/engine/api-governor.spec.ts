import { Budget, HttpClient, LimitError, TransportError } from '@drupflare/workforce';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitedError } from '../../../engine/src/account-usage';
import {
	ApiGovernor,
	DEFAULT_MAX_WAIT_MS,
	governedFetch,
	parseItems,
	policyOf,
	SHARED_QUOTA,
	SHARED_WINDOW_MS,
	type GovernedFetchOptions
} from '../../../engine/src/api-governor';

const NOW = 1_790_000_000_000;

function headers(entries: Record<string, string>): Headers {
	return new Headers(entries);
}

describe('parseItems', () => {
	it('reads a named item with its parameters in either order', () => {
		expect(parseItems('"default";r=1199;t=120')).toEqual([
			{ name: 'default', params: { r: 1199, t: 120 } }
		]);
		expect(parseItems('"default";t=120;r=1199')).toEqual([
			{ name: 'default', params: { t: 120, r: 1199 } }
		]);
	});

	it('reads several policies in one header', () => {
		expect(parseItems('"default";q=1200;w=300, "list_zones";q=1201;w=300')).toEqual([
			{ name: 'default', params: { q: 1200, w: 300 } },
			{ name: 'list_zones', params: { q: 1201, w: 300 } }
		]);
	});

	it('keeps an unnamed item and drops a malformed one', () => {
		expect(parseItems('r=5;t=60')).toEqual([{ name: null, params: { r: 5, t: 60 } }]);
		expect(parseItems('"default";r=abc;t=-1, junk')).toEqual([{ name: 'default', params: {} }]);
	});

	it('keeps extra numeric parameters, drops non-numeric ones, and reads an absent header as nothing', () => {
		expect(parseItems('"default";r=3;t=9;burst=1;policy=x')).toEqual([
			{ name: 'default', params: { r: 3, t: 9, burst: 1 } }
		]);
		expect(parseItems(null)).toEqual([]);
		expect(parseItems('')).toEqual([]);
	});
});

describe('ApiGovernor observe', () => {
	it('takes r and t from the ratelimit header and q and w from ratelimit-policy, in either order', () => {
		const forward = new ApiGovernor();
		forward.observe(
			'default',
			headers({
				ratelimit: '"default";r=1100;t=200',
				'ratelimit-policy': '"default";q=1200;w=300'
			}),
			NOW
		);
		const reverse = new ApiGovernor();
		reverse.observe(
			'default',
			headers({
				'ratelimit-policy': '"default";q=1200;w=300',
				ratelimit: '"default";r=1100;t=200'
			}),
			NOW
		);
		expect(forward.state.buckets).toEqual(reverse.state.buckets);
		expect(forward.state.buckets.get('default')).toMatchObject({
			quota: 1200,
			windowSeconds: 300,
			remaining: 1100,
			resetAt: NOW + 200_000
		});
	});

	it('keeps list_zones apart from default', () => {
		const governor = new ApiGovernor();
		governor.observe(
			'default',
			headers({
				ratelimit: '"default";r=7;t=60, "list_zones";r=1200;t=60',
				'ratelimit-policy': '"default";q=1200;w=300, "list_zones";q=1201;w=300'
			}),
			NOW
		);
		expect(governor.state.buckets.get('default')?.remaining).toBe(7);
		expect(governor.state.buckets.get('list_zones')).toMatchObject({
			remaining: 1200,
			quota: 1201
		});
	});

	it('does nothing for a missing or malformed header and keeps the state sane', () => {
		const governor = new ApiGovernor();
		governor.observe('default', headers({}), NOW);
		governor.observe(
			'default',
			headers({ ratelimit: 'garbage', 'ratelimit-policy': '???' }),
			NOW
		);
		expect(governor.state.buckets.size).toBe(0);
		expect(governor.observations()).toEqual([]);
	});

	it('records each reading in a ring of 100', () => {
		const governor = new ApiGovernor();
		for (let i = 0; i < 150; i += 1) {
			governor.observe('default', headers({ ratelimit: `"default";r=${i};t=60` }), NOW + i);
		}
		const kept = governor.observations();
		expect(kept).toHaveLength(100);
		expect(kept[0]).toEqual({ policy: 'default', r: 50, t: 60, at: NOW + 50 });
		expect(kept[99]).toEqual({ policy: 'default', r: 149, t: 60, at: NOW + 149 });
	});
});

describe('ApiGovernor admit', () => {
	it('refuses an exhausted bucket until its reset, then admits again', () => {
		const governor = new ApiGovernor();
		governor.observe('default', headers({ ratelimit: '"default";r=0;t=60' }), NOW);
		expect(governor.admit('default', NOW)).toEqual({ ok: false, waitMs: 60_000 });
		expect(governor.admit('default', NOW + 30_000)).toEqual({ ok: false, waitMs: 30_000 });
		expect(governor.admit('default', NOW + 60_000)).toEqual({ ok: true });
	});

	it('counts down its own remaining between observations', () => {
		const governor = new ApiGovernor();
		governor.observe('default', headers({ ratelimit: '"default";r=2;t=60' }), NOW);
		expect(governor.admit('default', NOW)).toEqual({ ok: true });
		expect(governor.admit('default', NOW)).toEqual({ ok: true });
		expect(governor.admit('default', NOW)).toEqual({ ok: false, waitMs: 60_000 });
	});

	it('trusts a lower remote r over its own count, and does not raise its count to a higher one', () => {
		const governor = new ApiGovernor();
		governor.observe('default', headers({ ratelimit: '"default";r=1000;t=100' }), NOW);
		governor.admit('default', NOW);
		governor.observe('default', headers({ ratelimit: '"default";r=3;t=100' }), NOW);
		expect(governor.state.buckets.get('default')?.remaining).toBe(3);
		governor.observe('default', headers({ ratelimit: '"default";r=500;t=100' }), NOW);
		expect(governor.state.buckets.get('default')?.remaining).toBe(3);
	});

	it('pauses one policy on Retry-After and leaves the other running', () => {
		const governor = new ApiGovernor();
		governor.retryAfter('default', 30, NOW);
		expect(governor.admit('default', NOW)).toEqual({ ok: false, waitMs: 30_000 });
		expect(governor.admit('list_zones', NOW)).toEqual({ ok: true });
	});

	it('ignores a Retry-After that is not a positive number', () => {
		const governor = new ApiGovernor();
		governor.retryAfter('default', 0, NOW);
		governor.retryAfter('default', Number.NaN, NOW);
		expect(governor.admit('default', NOW)).toEqual({ ok: true });
	});

	it('counts every admitted request against the shared 1,200 per 300 s, unseen policy or not', () => {
		const governor = new ApiGovernor();
		for (let i = 0; i < SHARED_QUOTA; i += 1) {
			expect(governor.admit(`unnamed-${i % 3}`, NOW)).toEqual({ ok: true });
		}
		expect(governor.admit('unnamed-0', NOW)).toEqual({ ok: false, waitMs: SHARED_WINDOW_MS });
		expect(governor.admit('default', NOW + SHARED_WINDOW_MS - 1)).toEqual({
			ok: false,
			waitMs: 1
		});
		expect(governor.admit('default', NOW + SHARED_WINDOW_MS)).toEqual({ ok: true });
	});

	it('lets a spent bucket for one policy not block the shared count of another', () => {
		const governor = new ApiGovernor();
		governor.observe('list_zones', headers({ ratelimit: '"list_zones";r=0;t=60' }), NOW);
		expect(governor.admit('list_zones', NOW)).toEqual({ ok: false, waitMs: 60_000 });
		expect(governor.admit('default', NOW)).toEqual({ ok: true });
	});
});

describe('governedFetch', () => {
	let clock: number;
	let sleeps: number[];

	beforeEach(() => {
		clock = NOW;
		sleeps = [];
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// a fetch that answers from a queue; the wrapper must not call it more often than the test expects
	function queue(...list: Response[]) {
		return vi.fn(async () => {
			const next = list.shift();
			if (next === undefined) throw new Error('no response left');
			return next;
		});
	}

	function wrap(
		governor: ApiGovernor,
		fetch: ReturnType<typeof queue>,
		options: GovernedFetchOptions = {}
	) {
		return governedFetch(fetch, governor, {
			now: () => clock,
			sleep: async (ms) => {
				sleeps.push(ms);
				clock += ms;
			},
			...options
		});
	}

	const ACCOUNT_URL = 'https://api.cloudflare.com/client/v4/accounts/a/x';

	it('feeds every response header to the governor', async () => {
		const fetch = queue(
			new Response(null, {
				status: 200,
				headers: {
					ratelimit: '"default";r=1190;t=200',
					'ratelimit-policy': '"default";q=1200;w=300'
				}
			})
		);
		const governor = new ApiGovernor();
		const observe = vi.spyOn(governor, 'observe');
		const response = await wrap(governor, fetch)(ACCOUNT_URL);
		expect(response.status).toBe(200);
		expect(observe).toHaveBeenCalledWith('default', expect.anything(), NOW);
		expect(governor.state.buckets.get('default')?.remaining).toBe(1190);
	});

	it('retries once after a 429 Retry-After pause, and not a second time', async () => {
		const fetch = queue(
			new Response(null, { status: 429, headers: { 'retry-after': '7' } }),
			new Response(null, { status: 429, headers: { 'retry-after': '7' } }),
			new Response(null, { status: 200 })
		);
		const response = await wrap(new ApiGovernor(), fetch)(ACCOUNT_URL);
		expect(response.status).toBe(429);
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(sleeps).toEqual([7000]);
	});

	it('pauses only the policy the 429 names', async () => {
		const governor = new ApiGovernor();
		const fetch = queue(
			new Response(null, {
				status: 429,
				headers: { 'retry-after': '20', ratelimit: '"list_zones";r=0;t=20' }
			}),
			new Response(null, { status: 200 })
		);
		await wrap(governor, fetch)('https://api.cloudflare.com/client/v4/zones');
		expect(governor.admit('default', clock)).toEqual({ ok: true });
		expect(sleeps).toEqual([20_000]);
	});

	it('does not retry a 429 that names no Retry-After', async () => {
		const fetch = queue(
			new Response(null, { status: 429 }),
			new Response(null, { status: 200 })
		);
		expect((await wrap(new ApiGovernor(), fetch)(ACCOUNT_URL)).status).toBe(429);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
	});

	it('returns a 429 whose pause is past the wait cap, and still pauses the policy', async () => {
		const governor = new ApiGovernor();
		const fetch = queue(
			new Response(null, { status: 429, headers: { 'retry-after': '300' } }),
			new Response(null, { status: 200 })
		);
		expect((await wrap(governor, fetch)(ACCOUNT_URL)).status).toBe(429);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(governor.admit('default', clock)).toEqual({ ok: false, waitMs: 300_000 });
	});

	it('answers a refusal with a synthetic 429 whose Retry-After rounds up to whole seconds', async () => {
		const governor = new ApiGovernor();
		governor.retryAfter('default', 40.2, clock);
		const fetch = queue(new Response(null, { status: 200 }));
		const response = await wrap(governor, fetch)(ACCOUNT_URL);
		expect(response.status).toBe(429);
		expect(response.headers.get('retry-after')).toBe('41');
		expect(response.headers.get('cache-control')).toBe('no-store');
		expect(response.headers.get('ratelimit')).toBeNull();
		expect(await response.json()).toEqual({ ok: false, code: 'governed' });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('does not record a refusal as an observation or count it against the shared quota', async () => {
		const governor = new ApiGovernor();
		governor.retryAfter('default', 40, clock);
		const observe = vi.spyOn(governor, 'observe');
		await wrap(governor, queue())(ACCOUNT_URL);
		expect(observe).not.toHaveBeenCalled();
		expect(governor.observations()).toEqual([]);
		expect(governor.state.shared).toEqual([]);
	});

	it('refuses with a typed error when asked to, and the wait passes the cap, without calling fetch', async () => {
		const governor = new ApiGovernor();
		governor.retryAfter('default', DEFAULT_MAX_WAIT_MS / 1000 + 1, clock);
		const fetch = queue(new Response(null, { status: 200 }));
		const error = await wrap(governor, fetch, { throwOnRefusal: true })(ACCOUNT_URL).catch(
			(caught: unknown) => caught
		);
		expect(error).toBeInstanceOf(RateLimitedError);
		expect((error as RateLimitedError).retryAfterMs).toBe(DEFAULT_MAX_WAIT_MS + 1000);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('sends no request on a real 429 when the wrapper retry is off, and still pauses the policy the 429 names', async () => {
		const governor = new ApiGovernor();
		const fetch = queue(
			new Response(null, {
				status: 429,
				headers: { 'retry-after': '20', ratelimit: '"list_zones";r=0;t=20' }
			}),
			new Response(null, { status: 200 })
		);
		const response = await wrap(governor, fetch, { retryOnce: false })(
			'https://api.cloudflare.com/client/v4/zones'
		);
		expect(response.status).toBe(429);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(sleeps).toEqual([]);
		expect(governor.admit('list_zones', clock)).toEqual({ ok: false, waitMs: 20_000 });
		expect(governor.admit('default', clock)).toEqual({ ok: true });
	});

	it('sends no Authorization value in the refusal body or headers', async () => {
		const secret = 'cfut_SECRET_VALUE_123';
		const governor = new ApiGovernor();
		governor.retryAfter('default', 999, clock);
		const init = { headers: { authorization: `Bearer ${secret}` } };
		const response = await wrap(governor, queue())(ACCOUNT_URL, init);
		expect(await response.text()).not.toContain(secret);
		expect([...response.headers.values()].join(' ')).not.toContain(secret);
	});

	it('makes workforce pace a refusal and stop with a LimitError, not a TransportError', async () => {
		const governor = new ApiGovernor();
		governor.retryAfter('default', 999, clock);
		const inner = queue(new Response(null, { status: 200 }));
		const budgetClock = { t: NOW };
		const waits: number[] = [];
		const client = new HttpClient(() => ({ authorization: 'Bearer unused' }), {
			fetch: wrap(governor, inner),
			budget: new Budget({
				now: () => budgetClock.t,
				sleep: async (ms) => {
					budgetClock.t += ms;
				}
			}),
			sleep: async (ms) => {
				waits.push(ms);
			},
			now: () => clock
		});
		const error = await client.request('/accounts/a/x').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LimitError);
		expect(error).not.toBeInstanceOf(TransportError);
		expect(inner).not.toHaveBeenCalled();
		expect(waits).toEqual([999_000, 999_000, 999_000]);
	});

	it('lets workforce own the retry, one request per attempt, when the wrapper retry is off', async () => {
		const inner = queue(
			...[0, 1, 2, 3].map(
				() => new Response(null, { status: 429, headers: { 'retry-after': '1' } })
			)
		);
		const budgetClock = { t: NOW };
		const client = new HttpClient(() => ({ authorization: 'Bearer unused' }), {
			fetch: wrap(new ApiGovernor(), inner, { retryOnce: false }),
			budget: new Budget({
				now: () => budgetClock.t,
				sleep: async (ms) => {
					budgetClock.t += ms;
				}
			}),
			sleep: async () => {},
			now: () => clock
		});
		const error = await client.request('/accounts/a/x').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(LimitError);
		expect(inner).toHaveBeenCalledTimes(4);
	});

	it('waits a bounded admission then sends, when the wait is under the cap', async () => {
		const governor = new ApiGovernor();
		governor.observe('default', headers({ ratelimit: '"default";r=0;t=5' }), clock);
		const fetch = queue(new Response(null, { status: 200 }));
		expect((await wrap(governor, fetch)(ACCOUNT_URL)).status).toBe(200);
		expect(sleeps).toEqual([5000]);
	});

	it('never puts an Authorization value in a thrown error or in a log', async () => {
		const secret = 'cfut_SECRET_VALUE_123';
		const logs = vi.spyOn(console, 'log');
		const warns = vi.spyOn(console, 'warn');
		const errors = vi.spyOn(console, 'error');
		const governor = new ApiGovernor();
		governor.retryAfter('default', 999, clock);
		const fetch = queue(new Response(null, { status: 200 }));
		const init = { headers: { authorization: `Bearer ${secret}` } };
		const error = await wrap(governor, fetch, { throwOnRefusal: true })(
			ACCOUNT_URL,
			init
		).catch((caught: unknown) => caught);
		expect(String((error as Error).message)).not.toContain(secret);
		expect(logs).not.toHaveBeenCalled();
		expect(warns).not.toHaveBeenCalled();
		expect(errors).not.toHaveBeenCalled();
	});
});

describe('policyOf', () => {
	it('sends a GET to a zones list to list_zones and everything else to default', () => {
		expect(policyOf('https://api.cloudflare.com/client/v4/zones?per_page=1')).toBe(
			'list_zones'
		);
		expect(policyOf('https://api.cloudflare.com/client/v4/zones', { method: 'POST' })).toBe(
			'default'
		);
		expect(policyOf('https://api.cloudflare.com/client/v4/accounts/a')).toBe('default');
	});
});
