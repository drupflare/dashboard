import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	capacityServices,
	cloudflareReadsOf,
	readCapacity,
	resetCapacityServices,
	setCapacityServices
} from '../../../../src/server/services/capacity';
import { KV_NAMESPACE_LIMIT } from '../../../../src/shared/capacity';
import { ApiError } from '../../../../src/shared/errors';

const ACCOUNT = 'a'.repeat(32);
const TOKEN = 'secret-token-value-0123456789';
const NOW = Date.parse('2026-11-12T12:00:00Z');

const grant = {
	has_record: true,
	confirmed_balance_cents: 999_958,
	original_amount_cents: 1_000_000,
	currency: 'USD',
	valid_from: '2026-11-12T00:00:00Z',
	valid_to: '2027-11-12T00:00:00Z',
	days_remaining: 363,
	projected_depletion_date: null
};

const usageRows = [
	{
		ServiceName: 'R2',
		ChargePeriodStart: '2026-11-02T00:00:00Z',
		EffectiveCost: 2,
		BillingCurrency: 'USD'
	},
	{
		ServiceName: 'Workers',
		ChargePeriodStart: '2026-11-03T00:00:00Z',
		EffectiveCost: 5,
		BillingCurrency: 'USD'
	}
];

interface World {
	credits?: () => Response;
	usage?: () => Response;
	kv?: number;
	scripts?: () => Response;
}

const ok = (result: unknown, headers: Record<string, string> = {}) =>
	new Response(
		JSON.stringify({
			success: true,
			result,
			result_info: { page: 1, per_page: 100, count: 1, total_count: 1, total_pages: 1 }
		}),
		{ headers: { 'content-type': 'application/json', ...headers } }
	);

// answers by path and records every request, so a test can count what went upstream
function cloudflare(world: World = {}) {
	const paths: string[] = [];
	const methods = new Set<string>();
	const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
		const path = new URL(String(input)).pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '');
		paths.push(path);
		methods.add(init?.method ?? 'GET');
		if (path === '/billing/credits') return world.credits?.() ?? ok(grant);
		if (path === '/billable-usage') return world.usage?.() ?? ok(usageRows);
		if (path === '/r2/buckets') return ok({ buckets: [{ name: 'a' }, { name: 'b' }] });
		if (path === '/workers/scripts') {
			return (
				world.scripts?.() ??
				ok([{ id: 'one' }, { id: 'two' }, { id: 'three' }, { id: 'four' }])
			);
		}
		if (path === '/d1/database') return ok([{ uuid: 'd1', name: 'db', created_at: null }]);
		const namespaces = Array.from({ length: world.kv ?? 3 }, (_, n) => ({
			id: `kv-${n}`,
			title: `ns-${n}`
		}));
		return ok(namespaces, {
			ratelimit: '"default";r=1100;t=250',
			'ratelimit-policy': '"default";q=1200;w=300'
		});
	};
	return { fetcher, paths, methods };
}

function database() {
	const asked: string[] = [];
	const db = {
		async allAllShards(sql: string) {
			asked.push(sql);
			let results: Record<string, unknown>[] = [];
			if (sql.includes('GROUP BY state')) results = [{ key: 'active', n: 4 }];
			else if (sql.includes('ORDER BY o.updated_at')) {
				results = [
					{
						id: 'op_old',
						type: 'site.create',
						site_id: 'site_1',
						status: 'failed',
						failed_step: 'verify',
						updated_at: NOW - 5000
					},
					{
						id: 'op_new',
						type: 'site.upgrade',
						site_id: null,
						status: 'rolled-back',
						failed_step: null,
						updated_at: NOW - 1000
					}
				];
			} else if (sql.includes("'running'")) results = [{ n: 2 }, { n: 1 }];
			else if (sql.includes("'failed'")) results = [{ n: 2 }];
			return [{ success: true, results }];
		}
	};
	return { db: db as unknown as CollegeDBClient, asked };
}

function install(world: World = {}, over: { now?: () => number } = {}) {
	const upstream = cloudflare(world);
	const { db, asked } = database();
	let clock = NOW;
	setCapacityServices({
		getDb: async () => db,
		reads: cloudflareReadsOf({ accountId: ACCOUNT, token: TOKEN }, upstream.fetcher),
		now: over.now ?? (() => clock),
		cacheMs: 60_000
	});
	return {
		...upstream,
		asked,
		advance: (ms: number) => {
			clock += ms;
		}
	};
}

beforeEach(() => {
	vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
	resetCapacityServices();
	vi.restoreAllMocks();
});

describe('readCapacity', () => {
	it('reads the grant, the usage by service, the headroom and the work in flight', async () => {
		const world = install();
		const view = await readCapacity();
		expect(view.generatedAt).toBe(NOW);
		expect(view.credits).toMatchObject({
			state: 'ok',
			balanceCents: 999_958,
			originalCents: 1_000_000,
			usedCents: 42,
			daysRemaining: 363
		});
		expect(view.usage).toEqual({
			state: 'ok',
			currency: 'USD',
			from: '2026-11-02',
			through: '2026-11-03',
			totalCents: 700,
			services: [
				{ name: 'Workers', cents: 500 },
				{ name: 'R2', cents: 200 }
			]
		});
		expect(view.headroom).toEqual({
			state: 'ok',
			kvNamespaces: 3,
			kvLimit: KV_NAMESPACE_LIMIT,
			buckets: 2,
			scripts: 4,
			databases: 1,
			rate: { remaining: 1100, quota: 1200, resetSeconds: 250, windowSeconds: 300 }
		});
		expect(view.work).toEqual({
			running: 3,
			failedLastDay: 2,
			sites: { active: 4 },
			recentFailures: [
				{
					id: 'op_new',
					type: 'site.upgrade',
					siteId: null,
					reason: 'Stopped before it could finish.',
					at: NOW - 1000
				},
				{
					id: 'op_old',
					type: 'site.create',
					siteId: 'site_1',
					reason: 'Stopped while checking that the site answers.',
					at: NOW - 5000
				}
			]
		});
		expect(world.methods).toEqual(new Set(['GET']));
	});

	it('never puts the token or the account id in what it returns', async () => {
		install();
		const text = JSON.stringify(await readCapacity());
		expect(text).not.toContain(TOKEN);
		expect(text).not.toContain(ACCOUNT);
	});

	it('answers no billing access for a 403 and still renders the headroom and the usage', async () => {
		install({ credits: () => new Response('{}', { status: 403 }) });
		const view = await readCapacity();
		expect(view.credits).toEqual({ state: 'no_billing_access' });
		expect(view.headroom.state).toBe('ok');
		expect(view.usage.state).toBe('ok');
		expect(view.work.running).toBe(3);
	});

	it('shows usage as unavailable on an unexpected shape and leaves the credits working', async () => {
		install({ usage: () => ok({ unexpected: true }) });
		const view = await readCapacity();
		expect(view.usage).toEqual({ state: 'unavailable' });
		expect(view.credits.state).toBe('ok');
	});

	it('reads a server failure and a network failure as unavailable', async () => {
		install({ credits: () => new Response('{}', { status: 500 }) });
		expect((await readCapacity()).credits).toEqual({ state: 'unavailable' });
		resetCapacityServices();
		const { db } = database();
		setCapacityServices({
			getDb: async () => db,
			reads: cloudflareReadsOf({ accountId: ACCOUNT, token: TOKEN }, async () => {
				throw new TypeError('offline');
			})
		});
		const view = await readCapacity();
		expect(view.credits).toEqual({ state: 'unavailable' });
		expect(view.usage).toEqual({ state: 'unavailable' });
		expect(view.headroom).toEqual({ state: 'unavailable' });
		expect(view.work.failedLastDay).toBe(2);
	});

	it('says every Cloudflare section is not configured when the Worker has no credentials', async () => {
		const { db } = database();
		setCapacityServices({ getDb: async () => db, reads: null });
		const view = await readCapacity();
		expect(view.credits).toEqual({ state: 'not_configured' });
		expect(view.usage).toEqual({ state: 'not_configured' });
		expect(view.headroom).toEqual({ state: 'not_configured' });
	});

	it('answers none for an account with no credit record', async () => {
		install({ credits: () => ok({ has_record: false }) });
		expect((await readCapacity()).credits).toEqual({ state: 'none' });
	});

	it('fails with a plain not-built error before the platform store is installed', async () => {
		const error = await readCapacity().catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).code).toBe('not_built');
	});
});

describe('the 60 second cache', () => {
	it('sends one upstream call per endpoint for two requests inside the minute', async () => {
		const world = install();
		await readCapacity();
		const first = world.paths.length;
		await readCapacity();
		expect(world.paths).toHaveLength(first);
		expect(world.paths.filter((path) => path === '/billing/credits')).toHaveLength(1);
		expect(world.paths.filter((path) => path === '/billable-usage')).toHaveLength(1);
		expect(world.paths.filter((path) => path === '/r2/buckets')).toHaveLength(1);
	});

	it('shares one read between requests that overlap', async () => {
		const world = install();
		await Promise.all([readCapacity(), readCapacity()]);
		expect(world.paths.filter((path) => path === '/billing/credits')).toHaveLength(1);
	});

	it('reads again once the minute has passed', async () => {
		const world = install();
		await readCapacity();
		world.advance(59_999);
		await readCapacity();
		expect(world.paths.filter((path) => path === '/billing/credits')).toHaveLength(1);
		world.advance(2);
		await readCapacity();
		expect(world.paths.filter((path) => path === '/billing/credits')).toHaveLength(2);
	});

	it('keeps a failed read for the minute so a broken token is not retried per request', async () => {
		const world = install({ credits: () => new Response('{}', { status: 403 }) });
		await readCapacity();
		await readCapacity();
		expect(world.paths.filter((path) => path === '/billing/credits')).toHaveLength(1);
	});

	it('reads the work in flight on every request, since it is a local query', async () => {
		const world = install();
		await readCapacity();
		const before = world.asked.length;
		await readCapacity();
		expect(world.asked.length).toBe(before * 2);
	});
});

describe('cloudflareReadsOf', () => {
	it('returns nothing without both an account id and a token', () => {
		const fetcher = cloudflare().fetcher;
		expect(cloudflareReadsOf({ accountId: undefined, token: TOKEN }, fetcher)).toBeNull();
		expect(cloudflareReadsOf({ accountId: ACCOUNT, token: undefined }, fetcher)).toBeNull();
		expect(cloudflareReadsOf({ accountId: '', token: '' }, fetcher)).toBeNull();
	});

	it('reads the account usage with the token as a bearer credential and nothing else', async () => {
		const auth: (string | null)[] = [];
		const reads = cloudflareReadsOf(
			{ accountId: ACCOUNT, token: TOKEN },
			async (input, init) => {
				auth.push(new Headers(init?.headers).get('authorization'));
				return cloudflare().fetcher(input, init);
			}
		);
		const view = await reads?.headroom();
		expect(view?.kvNamespaces).toBe(3);
		expect(auth.length).toBeGreaterThan(0);
		expect(new Set(auth)).toEqual(new Set([`Bearer ${TOKEN}`]));
	});

	it('fails a headroom read instead of waiting out a spent rate budget', async () => {
		const reads = cloudflareReadsOf({ accountId: ACCOUNT, token: TOKEN }, async () =>
			ok([], {
				ratelimit: '"default";r=0;t=250',
				'ratelimit-policy': '"default";q=1200;w=300'
			})
		);
		await expect(reads?.headroom()).rejects.toThrow('rate budget');
	});

	it('shows the rest of the headroom when the script listing fails', async () => {
		install({ scripts: () => new Response('no', { status: 500 }) });
		const view = await readCapacity();
		expect(view.headroom).toMatchObject({
			state: 'ok',
			kvNamespaces: 3,
			scripts: null,
			databases: 1
		});
	});

	it('counts the namespaces of a large account against the default limit', async () => {
		const world = install({ kv: 850 });
		const view = await readCapacity();
		expect(view.headroom).toMatchObject({ kvNamespaces: 850, kvLimit: 1000 });
		expect(world.methods).toEqual(new Set(['GET']));
	});

	it('leaves the installed services as the tests set them', () => {
		install();
		expect(capacityServices().cacheMs).toBe(60_000);
	});
});
