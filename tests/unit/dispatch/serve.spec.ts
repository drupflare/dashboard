import { generateSigningKey } from '@contracts/common';
import {
	DEFAULT_CLOCK_SKEW_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_STALE_GRACE_MS,
	issueLease,
	type Lease
} from '@contracts/site-auth';
import { describe, expect, it } from 'vitest';
import { signApply } from '../../../dispatch/src/authority';
import { serve, type ServeDeps, type SiteAuthClient } from '../../../dispatch/src/serve';
import { createSpike, signSpike, type SpikeBody } from '../../../dispatch/src/spike';
import { parseReadout } from '../../../scripts/spikes/counting/plan';
import { authorityState, counterDouble, deferred, makeRig } from './fakes';

const HOST = 'calm-river-stone.drupflare.app';
const CONTROL = 'control.drupflare.test';

function seeded(seed: number): () => number {
	let a = seed | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

async function world(patch: Parameters<typeof authorityState>[0] = {}) {
	const rig = await makeRig();
	const state = await authorityState({ epoch: 3, ...patch });
	await rig.commit(state);
	const routes = new Map<string, string>();
	const setRoute = (epoch = state.epoch, host = HOST) =>
		routes.set(
			host,
			JSON.stringify({ v: 1, siteId: state.siteId, script: 'tenant-one', epoch })
		);
	setRoute();
	const served: { script: string; limits: unknown }[] = [];
	const views: unknown[] = [];
	const pending: Promise<unknown>[] = [];
	const issued: Lease[] = [];
	const watched: SiteAuthClient = {
		...rig.client,
		async lease(request) {
			const result = await rig.client.lease(request);
			if (result.ok) issued.push(result.lease);
			return result;
		},
		async renew(request) {
			const result = await rig.client.renew(request);
			if (result.ok) issued.push(result.lease);
			return result;
		}
	};
	const reads = { count: 0 };
	const deps: ServeDeps = {
		now: rig.clock.now,
		publicKey: rig.lease.publicKey,
		controlHost: CONTROL,
		readRoute: async (host) => {
			reads.count++;
			return routes.get(host) ?? null;
		},
		siteAuth: () => watched,
		tenant: (script, limits) => ({
			fetch: async () => {
				served.push({ script, limits });
				return new Response('tenant');
			}
		}),
		cache: new Map(),
		inflight: new Map(),
		revoked: new Set(),
		waitUntil: (promise) => void pending.push(promise),
		onView: (view) => void views.push(view),
		askTimeoutMs: 5_000
	};
	const get = (host = HOST) => serve(new Request(`https://${host}/page`), deps);
	const flush = async () => {
		await Promise.all(pending.splice(0));
	};
	return { rig, state, routes, setRoute, served, views, issued, deps, get, flush, reads };
}

const total = (calls: { lease: number; renew: number }) => calls.lease + calls.renew;

describe('routing', () => {
	it('answers 404 with no SITE_AUTH call for an unknown host', async () => {
		const w = await world();
		const response = await w.get('nobody.drupflare.app');
		expect(response.status).toBe(404);
		expect(total(w.rig.calls)).toBe(0);
		expect(w.served).toHaveLength(0);
	});

	it('answers 404 with no SITE_AUTH call for a malformed entry', async () => {
		const w = await world();
		w.routes.set(HOST, '{"v":1}');
		expect((await w.get()).status).toBe(404);
		w.routes.set(HOST, 'not json');
		expect((await w.get()).status).toBe(404);
		expect(total(w.rig.calls)).toBe(0);
		expect(w.served).toHaveLength(0);
	});

	it('answers 503 and serves nothing when the route store throws', async () => {
		const w = await world();
		w.deps.readRoute = async () => {
			throw new Error('kv down');
		};
		expect((await w.get()).status).toBe(503);
		expect(w.served).toHaveLength(0);
	});

	it('never admits on a KV entry alone: an entry for a site the authority does not know is a 404', async () => {
		const w = await world();
		w.routes.set(
			HOST,
			JSON.stringify({ v: 1, siteId: 'site_ghost000001', script: 'ghost', epoch: 1 })
		);
		w.deps.siteAuth = () => ({
			...w.rig.client,
			lease: async () => ({ ok: false, code: 'unknown_site' })
		});
		const response = await w.get();
		expect(response.status).toBe(404);
		expect(w.served).toHaveLength(0);
	});

	it('never admits on a KV entry alone: a revoked site is a 403 whatever the entry says', async () => {
		const w = await world();
		await w.rig.commit({ ...w.state, generation: 2, state: 'revoked' });
		const response = await w.get();
		expect(response.status).toBe(403);
		expect(w.served).toHaveLength(0);
	});

	it('asks SITE_AUTH once for a revoked site, then refuses from memory until the epoch moves', async () => {
		const w = await world();
		await w.rig.commit({ ...w.state, generation: 2, state: 'revoked' });
		for (let i = 0; i < 5; i++) expect((await w.get()).status).toBe(403);
		expect(total(w.rig.calls)).toBe(1);
		await w.rig.commit({ ...w.state, generation: 3, epoch: 4, state: 'active' });
		w.setRoute(4);
		expect((await w.get()).status).toBe(200);
		expect(total(w.rig.calls)).toBe(2);
	});
});

describe('lease mode', () => {
	it('asks once, serves with the limits from the lease and then serves from the cache', async () => {
		const w = await world();
		expect((await w.get()).status).toBe(200);
		expect(w.served[0]).toEqual({
			script: 'tenant-one',
			limits: { cpuMs: 50, subRequests: 20 }
		});
		expect(w.rig.calls.lease).toBe(1);
		w.rig.clock.advance(5_000);
		expect((await w.get()).status).toBe(200);
		expect(total(w.rig.calls)).toBe(1);
	});

	it('renews once in the background when a third of the life remains, however many requests arrive', async () => {
		const w = await world();
		await w.get();
		w.rig.clock.advance(DEFAULT_LEASE_MS - DEFAULT_LEASE_MS / 3);
		const responses = await Promise.all(Array.from({ length: 20 }, () => w.get()));
		expect(responses.every((r) => r.status === 200)).toBe(true);
		await w.flush();
		expect(w.rig.calls.renew).toBe(1);
		expect(w.deps.cache.size).toBe(1);
		const renewed = [...w.deps.cache.values()][0];
		expect(renewed?.iat).toBe(w.rig.clock.now());
	});

	it('renews before serving once the lease has expired, and shares one call among waiters', async () => {
		const w = await world();
		await w.get();
		w.rig.clock.advance(DEFAULT_LEASE_MS + DEFAULT_CLOCK_SKEW_MS + 1);
		const responses = await Promise.all(Array.from({ length: 10 }, () => w.get()));
		expect(responses.every((r) => r.status === 200)).toBe(true);
		expect(w.rig.calls.renew).toBe(1);
	});

	it('forwards a 502 when the tenant script throws', async () => {
		const w = await world();
		w.deps.tenant = () => ({
			fetch: async () => {
				throw new Error('script missing');
			}
		});
		expect((await w.get()).status).toBe(502);
	});

	it('records a view after the response through waitUntil, and a failing writer changes nothing', async () => {
		const w = await world();
		expect((await w.get()).status).toBe(200);
		await w.flush();
		expect(w.views).toEqual([
			{ siteId: w.state.siteId, host: HOST, status: 200, serving: 'lease' }
		]);
		w.deps.onView = () => {
			throw new Error('analytics down');
		};
		expect((await w.get()).status).toBe(200);
		await w.flush().catch(() => undefined);
	});
});

describe('revocation bound', () => {
	it('no isolate serves past the last lease it could hold plus the clock skew, across 200 random schedules', async () => {
		for (let trial = 0; trial < 200; trial++) {
			const random = seeded(trial + 1);
			// odd trials are busy sites, even trials leave gaps longer than a lease
			const maxGapMs = trial % 2 ? 2_000 : 45_000;
			const w = await world();
			const start = w.rig.clock.now();
			const commitAt = start + Math.floor(random() * 60_000);
			let committed = false;
			let bound = Number.POSITIVE_INFINITY;
			let at = start;
			while (at < start + 120_000) {
				w.rig.clock.set(at);
				if (!committed && at >= commitAt) {
					w.rig.clock.set(commitAt);
					await w.rig.commit({ ...w.state, generation: 2, state: 'revoked' });
					bound =
						Math.max(0, ...w.issued.map((lease) => lease.exp)) + DEFAULT_CLOCK_SKEW_MS;
					committed = true;
					w.rig.clock.set(at);
				}
				const response = await w.get();
				await w.flush();
				if (committed && response.status === 200) {
					expect(at, `trial ${trial}`).toBeLessThanOrEqual(bound);
				}
				at += 50 + Math.floor(random() * maxGapMs);
			}
			expect(committed).toBe(true);
			w.rig.clock.set(bound + 1);
			expect((await w.get()).status).toBe(403);
		}
	});
});

describe('strict mode', () => {
	it('asks SITE_AUTH on every request and caches nothing', async () => {
		const w = await world({ risk: 'new-free' });
		for (let i = 0; i < 5; i++) {
			expect((await w.get()).status).toBe(200);
			w.rig.clock.advance(100);
		}
		expect(w.rig.calls.lease).toBe(5);
		expect(w.deps.cache.size).toBe(0);
	});

	it('refuses the request right after a revoke commit', async () => {
		const w = await world({ risk: 'abuse-watch' });
		expect((await w.get()).status).toBe(200);
		await w.rig.commit({ ...w.state, generation: 2, state: 'revoked' });
		w.rig.clock.advance(1);
		expect((await w.get()).status).toBe(403);
		expect(w.served).toHaveLength(1);
	});

	it('fails closed when SITE_AUTH throws, even after earlier successes', async () => {
		const w = await world({ risk: 'escalated' });
		expect((await w.get()).status).toBe(200);
		w.rig.down.value = true;
		const response = await w.get();
		expect(response.status).toBe(503);
		expect(response.headers.get('retry-after')).toBe('5');
		expect(w.served).toHaveLength(1);
	});

	it('fails closed when SITE_AUTH never answers', async () => {
		const w = await world({ risk: 'escalated' });
		w.deps.askTimeoutMs = 20;
		w.deps.siteAuth = () => ({ ...w.rig.client, lease: () => new Promise(() => undefined) });
		expect((await w.get()).status).toBe(503);
		expect(w.served).toHaveLength(0);
	});
});

describe('availability grace', () => {
	async function expired() {
		const w = await world();
		await w.get();
		w.rig.down.value = true;
		return w;
	}

	it('serves an expired lease-mode lease while SITE_AUTH is unreachable, up to the stale grace', async () => {
		const w = await expired();
		const lease = [...w.deps.cache.values()][0] as Lease;
		w.rig.clock.set(lease.exp + DEFAULT_CLOCK_SKEW_MS + 1);
		expect((await w.get()).status).toBe(200);
		w.rig.clock.set(lease.exp + DEFAULT_CLOCK_SKEW_MS + DEFAULT_STALE_GRACE_MS);
		expect((await w.get()).status).toBe(200);
	});

	it('stops at the stale grace', async () => {
		const w = await expired();
		const lease = [...w.deps.cache.values()][0] as Lease;
		w.rig.clock.set(lease.exp + DEFAULT_CLOCK_SKEW_MS + DEFAULT_STALE_GRACE_MS + 1);
		expect((await w.get()).status).toBe(503);
	});

	it('never applies to a suspended site, even inside the grace window', async () => {
		const w = await world({ state: 'suspended' });
		expect((await w.get()).status).toBe(403);
		const lease = [...w.issued][0] as Lease;
		w.rig.down.value = true;
		w.rig.clock.set(lease.exp + DEFAULT_CLOCK_SKEW_MS + 1);
		expect((await w.get()).status).toBe(403);
		expect(w.served).toHaveLength(0);
	});

	it('does not extend a revoke that SITE_AUTH answered: a refusal ends the cached lease', async () => {
		const w = await world();
		await w.get();
		w.rig.clock.advance(DEFAULT_LEASE_MS - DEFAULT_LEASE_MS / 3);
		await w.rig.commit({ ...w.state, generation: 2, state: 'revoked' });
		expect((await w.get()).status).toBe(200);
		await w.flush();
		expect((await w.get()).status).toBe(403);
	});
});

describe('fencing and lease checks', () => {
	it('refuses an older-epoch lease found under the new route key, and drops it', async () => {
		const w = await world({ epoch: 3 });
		await w.get();
		const old = [...w.deps.cache.values()][0] as Lease;
		w.deps.cache.clear();
		w.setRoute(4);
		w.deps.cache.set(`${w.state.siteId}:4`, old);
		const response = await w.get();
		expect(response.status).toBe(404);
		expect(w.served).toHaveLength(1);
		expect(w.deps.cache.size).toBe(0);
	});

	it('refuses when the route moves ahead of the authority epoch', async () => {
		const w = await world({ epoch: 3 });
		w.setRoute(4);
		expect((await w.get()).status).toBe(404);
		expect(w.served).toHaveLength(0);
	});

	it('refuses after the owner change commits: the next lease comes at the new epoch', async () => {
		const w = await world({ epoch: 3 });
		await w.get();
		await w.rig.commit({ ...w.state, generation: 2, epoch: 4 });
		w.setRoute(3);
		w.deps.cache.clear();
		expect((await w.get()).status).toBe(404);
		w.setRoute(4);
		expect((await w.get()).status).toBe(200);
	});

	it('refuses a lease from SITE_AUTH that was tampered with in transit', async () => {
		const w = await world();
		w.deps.siteAuth = () => ({
			...w.rig.client,
			lease: async (request) => {
				const result = await w.rig.client.lease(request);
				if (!result.ok) return result;
				return { ok: true, lease: { ...result.lease, exp: result.lease.exp + 3_600_000 } };
			}
		});
		expect((await w.get()).status).toBe(503);
		expect(w.served).toHaveLength(0);
		expect(w.deps.cache.size).toBe(0);
	});

	it('refuses a lease signed by another key and a lease for another site', async () => {
		const w = await world();
		const other = await generateSigningKey();
		const foreign = await issueLease(w.state, w.rig.clock.now(), other.privateKey);
		w.deps.siteAuth = () => ({
			...w.rig.client,
			lease: async () => ({ ok: true, lease: foreign })
		});
		expect((await w.get()).status).toBe(503);
		const state2 = await authorityState({ epoch: 3 });
		const mine = await issueLease(state2, w.rig.clock.now(), w.rig.lease.privateKey);
		w.deps.siteAuth = () => ({
			...w.rig.client,
			lease: async () => ({ ok: true, lease: mine })
		});
		expect((await w.get()).status).toBe(404);
		expect(w.served).toHaveLength(0);
	});

	it('refuses an expired lease handed back by SITE_AUTH', async () => {
		const w = await world();
		const stale = await issueLease(w.state, w.rig.clock.now() - 60_000, w.rig.lease.privateKey);
		w.deps.siteAuth = () => ({
			...w.rig.client,
			lease: async () => ({ ok: true, lease: stale })
		});
		expect((await w.get()).status).toBe(503);
		expect(w.served).toHaveLength(0);
	});
});

describe('control route', () => {
	async function post(w: Awaited<ReturnType<typeof world>>, body: string, method = 'POST') {
		return serve(
			new Request(`https://${CONTROL}/apply`, {
				method,
				body: method === 'POST' ? body : undefined
			}),
			w.deps
		);
	}

	it('applies a signed write without reading the route store or serving a tenant', async () => {
		const w = await world();
		const message = await signApply(
			{ ...w.state, generation: 2, state: 'suspended' },
			w.rig.clock.now(),
			w.rig.control.privateKey
		);
		const response = await post(w, JSON.stringify(message));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			ok: true,
			value: { applied: true, generation: 2 }
		});
		expect(w.reads.count).toBe(0);
		expect(w.served).toHaveLength(0);
	});

	it('answers 409 with the refusal code for a write the object refuses', async () => {
		const w = await world();
		const other = await generateSigningKey();
		const message = await signApply(
			{ ...w.state, generation: 2 },
			w.rig.clock.now(),
			other.privateKey
		);
		const response = await post(w, JSON.stringify(message));
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({ ok: false, code: 'bad_signature' });
	});

	it('answers 400, 405, 413 and 503 for junk, a GET, a large body and an unreachable object', async () => {
		const w = await world();
		expect((await post(w, 'nope')).status).toBe(400);
		expect((await post(w, '{"a":1}')).status).toBe(400);
		expect((await post(w, '', 'GET')).status).toBe(405);
		expect((await post(w, 'x'.repeat(5_000))).status).toBe(413);
		w.rig.down.value = true;
		const message = await signApply(
			{ ...w.state, generation: 2 },
			w.rig.clock.now(),
			w.rig.control.privateKey
		);
		expect((await post(w, JSON.stringify(message))).status).toBe(503);
	});

	it('a tenant host never reaches the control route, whatever its path', async () => {
		const w = await world();
		const response = await serve(
			new Request(`https://${HOST}/apply`, { method: 'POST', body: '{}' }),
			w.deps
		);
		expect(response.status).toBe(200);
		expect(w.rig.calls.apply).toBe(0);
	});
});

// #region counting and the stage routes

const HTML = 'text/html; charset=utf-8';
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function counting(
	opts: { state?: Parameters<typeof authorityState>[0]; batchSize?: number } = {}
) {
	const w = await world(opts.state);
	const counter = counterDouble(w.rig.clock.now);
	const mechs = new Map<string, string>();
	const lookups: string[] = [];
	const bound: Promise<unknown>[] = [];
	const evicts = { count: 0 };
	const gates: (() => void)[] = [];
	const lookup = { fail: false };
	const spike = createSpike({
		controlKey: w.rig.control.publicKey,
		now: w.rig.clock.now,
		sleep: () => new Promise<void>((resolve) => void gates.push(resolve)),
		readMechanism: async (siteId) => {
			lookups.push(siteId);
			if (lookup.fail) throw new Error('kv down');
			return mechs.get(siteId) ?? null;
		},
		counter: counter.stub,
		evict: () => (evicts.count++, 0),
		options: { batchSize: opts.batchSize ?? 1_000 },
		timeoutMs: 30
	});
	spike.bind((promise) => void bound.push(promise));
	w.deps.spike = spike;
	const reply = { status: 200, type: HTML as string | null, fail: false };
	w.deps.tenant = () => ({
		fetch: async () => {
			if (reply.fail) throw new Error('tenant down');
			return new Response('tenant', {
				status: reply.status,
				headers: reply.type === null ? {} : { 'content-type': reply.type }
			});
		}
	});
	const choose = (name: string | null) => {
		if (name !== null) mechs.set(w.state.siteId, name);
	};
	return { ...w, spike, counter, lookups, lookup, evicts, gates, reply, choose };
}

describe('counting in the serving path', () => {
	it('counts each 2xx text/html response once and no other response', async () => {
		const c = await counting();
		c.choose('write-through');
		const cases: [number, string | null, boolean][] = [
			[200, HTML, true],
			[206, 'text/html', true],
			[200, 'application/json', false],
			[200, null, false],
			[404, HTML, false],
			[500, HTML, false],
			[302, HTML, false]
		];
		for (const [status, type, view] of cases) {
			const before = c.counter.applies.length;
			c.reply.status = status;
			c.reply.type = type;
			expect((await c.get()).status).toBe(status);
			expect(c.counter.applies.length - before).toBe(view ? 1 : 0);
		}
		c.reply.fail = true;
		const before = c.counter.applies.length;
		expect((await c.get()).status).toBe(502);
		expect(c.counter.applies.length).toBe(before);
		expect(c.counter.applies.map((w) => w.ranges)).toEqual([
			[{ from: 1, to: 1 }],
			[{ from: 2, to: 2 }]
		]);
	});

	it('never counts a refused request', async () => {
		const c = await counting();
		c.choose('write-through');
		await c.rig.commit({ ...c.state, generation: 2, state: 'revoked' });
		expect((await c.get()).status).toBe(403);
		expect((await c.get('nobody.drupflare.app')).status).toBe(404);
		expect(c.counter.applies).toHaveLength(0);
	});

	it('holds the response for write-through until the counter answers', async () => {
		const c = await counting();
		c.choose('write-through');
		const gate = deferred();
		c.counter.mode.gate = gate.promise;
		let done = false;
		const response = c.get().then((r) => ((done = true), r));
		await settle();
		expect(c.counter.applies).toHaveLength(1);
		expect(done).toBe(false);
		gate.open();
		expect((await response).status).toBe(200);
	});

	it.each(['batched', 'hybrid'])('does not hold the response for %s', async (name) => {
		const c = await counting({ batchSize: 1 });
		c.choose(name);
		await c.get();
		const gate = deferred();
		c.counter.mode.gate = gate.promise;
		expect((await c.get()).status).toBe(200);
		await settle();
		expect(c.counter.applies).toHaveLength(2);
		expect(c.counter.applies[1]?.sync).toBe(false);
		gate.open();
	});

	it('holds the first hybrid view and the view that reaches the limit', async () => {
		const c = await counting({
			state: { limits: { cpuMs: 50, subRequests: 20, viewsPerMonth: 3 } }
		});
		c.choose('hybrid');
		await c.get();
		await c.get();
		await c.get();
		expect(c.counter.applies.map((w) => w.sync)).toEqual([true, true]);
		expect(c.counter.applies[1]?.ranges).toEqual([{ from: 2, to: 3 }]);
	});

	it('passes the lease views per month as the limit', async () => {
		const small = await counting({
			state: { limits: { cpuMs: 50, subRequests: 20, viewsPerMonth: 2 } },
			batchSize: 1_000
		});
		small.choose('hybrid');
		await small.get();
		await small.get();
		expect(small.counter.applies.map((w) => w.sync)).toEqual([true, true]);
		const large = await counting({ batchSize: 1_000 });
		large.choose('hybrid');
		await large.get();
		await large.get();
		expect(large.counter.applies.map((w) => w.sync)).toEqual([true]);
	});

	it.each(['write-through', 'batched', 'hybrid'])(
		'serves the same response when the %s counter fails or hangs',
		async (name) => {
			const c = await counting({ batchSize: 1 });
			c.choose(name);
			for (const mode of ['fail', 'hang', 'ok'] as const) {
				c.counter.mode.fail = mode === 'fail';
				c.counter.mode.hang = mode === 'hang';
				const response = await c.get();
				expect(response.status).toBe(200);
				expect(response.headers.get('content-type')).toBe(HTML);
				expect(await response.text()).toBe('tenant');
			}
			expect(c.counter.applies.length).toBeGreaterThan(0);
		}
	);

	it('does not count a site with no mechanism, a bad value or a failed lookup', async () => {
		const c = await counting();
		for (const bad of [null, '', 'off', 'WRITE-THROUGH', 'hybrid ']) {
			c.choose(bad);
			if (bad !== null) expect((await c.get()).status).toBe(200);
		}
		expect((await c.get()).status).toBe(200);
		expect(c.counter.applies).toHaveLength(0);
	});

	it('serves and counts nothing while the lookup fails, and counts once it recovers', async () => {
		const c = await counting();
		c.choose('write-through');
		c.lookup.fail = true;
		expect((await c.get()).status).toBe(200);
		expect(c.counter.applies).toHaveLength(0);
		c.lookup.fail = false;
		await c.get();
		expect(c.counter.applies).toHaveLength(1);
	});

	it('looks a site up once for the life of the isolate', async () => {
		const c = await counting();
		c.choose('batched');
		for (let i = 0; i < 4; i++) await c.get();
		expect(c.lookups).toEqual([c.state.siteId]);
	});

	it('answers as before when no stage switch built a spike', async () => {
		const w = await world();
		expect(w.deps.spike).toBeUndefined();
		expect((await w.get()).status).toBe(200);
		expect(await (await w.get()).text()).toBe('tenant');
	});
});

describe('stage routes', () => {
	async function signed(
		c: Awaited<ReturnType<typeof counting>>,
		body: SpikeBody,
		patch: { iat?: number; key?: CryptoKey; method?: string; path?: string; host?: string } = {}
	) {
		const message = await signSpike(
			body,
			patch.iat ?? c.rig.clock.now(),
			patch.key ?? c.rig.control.privateKey
		);
		return serve(
			new Request(`https://${patch.host ?? CONTROL}${patch.path ?? `/__spike/${body.op}`}`, {
				method: patch.method ?? 'POST',
				body: patch.method === 'GET' ? undefined : JSON.stringify(message)
			}),
			c.deps
		);
	}
	const COUNTS = (c: Awaited<ReturnType<typeof counting>>): SpikeBody => ({
		op: 'counts',
		siteId: c.state.siteId,
		hours: [Math.floor(1_790_000_000_000 / 3_600_000) * 3_600_000]
	});
	const untouched = (c: Awaited<ReturnType<typeof counting>>) => {
		expect(c.evicts.count).toBe(0);
		expect(c.counter.applies).toHaveLength(0);
	};

	it('answers a signed evict by running it once', async () => {
		const c = await counting();
		const response = await signed(c, { op: 'evict' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true, survivedAfterMb: 0 });
		expect(c.evicts.count).toBe(1);
	});

	it('returns counter rows in the shape the comparison script reads', async () => {
		const c = await counting();
		c.choose('write-through');
		await c.get();
		await c.get();
		const response = await signed(c, COUNTS(c));
		expect(response.status).toBe(200);
		const checked = parseReadout(await response.json());
		expect(checked.ok).toBe(true);
		if (!checked.ok) return;
		expect(checked.readout.hours[0]).toMatchObject({ issued: 2, origins: 1 });
		expect(checked.readout.counts.calls).toBe(2);
	});

	it.each([
		[
			'an unsigned body',
			async (c: Awaited<ReturnType<typeof counting>>) =>
				serve(
					new Request(`https://${CONTROL}/__spike/evict`, {
						method: 'POST',
						body: JSON.stringify({ v: 1, op: 'evict', iat: c.rig.clock.now() })
					}),
					c.deps
				),
			400
		],
		[
			'a signature from another key',
			async (c: Awaited<ReturnType<typeof counting>>) =>
				signed(c, { op: 'evict' }, { key: (await generateSigningKey()).privateKey }),
			403
		],
		[
			'a message older than five minutes',
			async (c: Awaited<ReturnType<typeof counting>>) =>
				signed(c, { op: 'evict' }, { iat: c.rig.clock.now() - 300_001 }),
			403
		],
		[
			'a message more than five minutes ahead',
			async (c: Awaited<ReturnType<typeof counting>>) =>
				signed(c, { op: 'evict' }, { iat: c.rig.clock.now() + 300_001 }),
			403
		],
		[
			'a signature made for another path',
			async (c: Awaited<ReturnType<typeof counting>>) =>
				signed(c, { op: 'evict' }, { path: '/__spike/counts' }),
			400
		]
	])(
		'refuses %s and touches neither the counter nor the isolate',
		async (_name, send, status) => {
			const c = await counting();
			const response = await send(c);
			expect(response.status).toBe(status);
			untouched(c);
		}
	);

	it('refuses a counts request whose body changed after it was signed', async () => {
		const c = await counting();
		const body = COUNTS(c);
		const message = await signSpike(body, c.rig.clock.now(), c.rig.control.privateKey);
		const response = await serve(
			new Request(`https://${CONTROL}/__spike/counts`, {
				method: 'POST',
				body: JSON.stringify({ ...message, siteId: 'site_other0000001' })
			}),
			c.deps
		);
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ ok: false, code: 'bad_signature' });
		untouched(c);
	});

	it('takes a write signed for the apply route only there', async () => {
		const c = await counting();
		const message = await signApply(
			{ ...c.state, generation: 2 },
			c.rig.clock.now(),
			c.rig.control.privateKey
		);
		const response = await serve(
			new Request(`https://${CONTROL}/__spike/evict`, {
				method: 'POST',
				body: JSON.stringify(message)
			}),
			c.deps
		);
		expect(response.status).toBe(400);
		untouched(c);
	});

	it('accepts a message just inside the five minute window', async () => {
		const c = await counting();
		expect(
			(await signed(c, { op: 'evict' }, { iat: c.rig.clock.now() - 299_000 })).status
		).toBe(200);
		expect(
			(await signed(c, { op: 'evict' }, { iat: c.rig.clock.now() + 299_000 })).status
		).toBe(200);
	});

	it('answers 405, 413 and the unknown-host 404 for a wrong method, a large body and an unknown path', async () => {
		const c = await counting();
		const unknown = await c.get('nobody.drupflare.app');
		expect((await signed(c, { op: 'evict' }, { method: 'GET' })).status).toBe(405);
		const large = await serve(
			new Request(`https://${CONTROL}/__spike/evict`, {
				method: 'POST',
				body: 'x'.repeat(5_000)
			}),
			c.deps
		);
		expect(large.status).toBe(413);
		const other = await signed(c, { op: 'evict' }, { path: '/__spike/other' });
		expect(other.status).toBe(unknown.status);
		expect(await other.text()).toBe(await unknown.text());
		untouched(c);
	});

	it('answers the unknown-host 404 without a spike, for a signed request too', async () => {
		const w = await world();
		const unknown = await w.get('nobody.drupflare.app');
		const message = await signSpike(
			{ op: 'evict' },
			w.rig.clock.now(),
			w.rig.control.privateKey
		);
		const response = await serve(
			new Request(`https://${CONTROL}/__spike/evict`, {
				method: 'POST',
				body: JSON.stringify(message)
			}),
			w.deps
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe(await unknown.text());
		expect(response.headers.get('cache-control')).toBe(unknown.headers.get('cache-control'));
		expect(w.rig.calls.apply).toBe(0);
	});

	it('leaves a tenant host path alone, whatever it is called', async () => {
		const c = await counting();
		const response = await signed(c, { op: 'evict' }, { host: HOST });
		expect(response.status).toBe(200);
		expect(await response.text()).toBe('tenant');
		untouched(c);
	});
});

// #endregion
