import { describe, expect, it } from 'vitest';
import {
	COUNTS_CONTEXT,
	COUNTS_MAX_HOURS,
	COUNTS_PATH,
	signCounts,
	verifyCounts,
	type CountsReader
} from '../../../dispatch/src/control-counts';
import { applyIn, hourOf, readHourIn, readMonthIn } from '../../../dispatch/src/counting';
import { serve } from '../../../dispatch/src/serve';
import { signSpike } from '../../../dispatch/src/spike';
import { authorityState, makeRig, memoryKv } from './fakes';

const CONTROL = 'control.drupflare.test';

async function setup() {
	const rig = await makeRig();
	const state = await authorityState();
	const stores = new Map<string, ReturnType<typeof memoryKv>>();
	const storeOf = (siteId: string) => {
		let kv = stores.get(siteId);
		if (!kv) stores.set(siteId, (kv = memoryKv()));
		return kv;
	};
	const reads: string[] = [];
	const counter = (siteId: string): CountsReader => ({
		read: async (hour) => readHourIn(storeOf(siteId), siteId, hour),
		month: async (month) => {
			reads.push(siteId);
			return readMonthIn(storeOf(siteId), month);
		}
	});
	const record = (siteId: string, views: number, at = rig.clock.now()) => {
		applyIn(
			storeOf(siteId),
			{
				siteId,
				hour: hourOf(at),
				origin: 'origin12345678',
				ranges: [{ from: 1, to: views }],
				issued: views,
				unavailable: false,
				sync: false
			},
			at,
			siteId
		);
	};
	const deps = {
		now: rig.clock.now,
		publicKey: rig.lease.publicKey,
		controlHost: CONTROL,
		controlKey: rig.control.publicKey,
		counts: counter,
		readRoute: async () => null,
		siteAuth: () => rig.client,
		tenant: () => ({ fetch: async () => new Response('tenant') }),
		cache: new Map(),
		inflight: new Map(),
		revoked: new Set<string>(),
		waitUntil: () => undefined
	};
	const month = new Date(rig.clock.now()).toISOString().slice(0, 7);
	const post = (body: unknown, method = 'POST', host = CONTROL) =>
		serve(
			new Request(`https://${host}${COUNTS_PATH}`, {
				method,
				body: method === 'GET' ? undefined : JSON.stringify(body)
			}),
			deps as never
		);
	return { rig, state, deps, record, post, month, reads, hour: hourOf(rig.clock.now()) };
}

describe('the signed counts read', () => {
	it('returns the month total and the counted hour for a site', async () => {
		const s = await setup();
		s.record('site_a', 7);
		const message = await signCounts(
			{ siteId: 'site_a', hours: [s.hour], months: [s.month] },
			s.rig.clock.now(),
			s.rig.control.privateKey
		);
		const response = await s.post(message);
		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		const body = (await response.json()) as {
			ok: boolean;
			months: { month: string; views: number }[];
			hours: { issued: number }[];
		};
		expect(body.months).toEqual([{ month: s.month, views: 7 }]);
		expect(body.hours[0]?.issued).toBe(7);
	});

	it('reads only the site it names and reports zero for a month with no views', async () => {
		const s = await setup();
		s.record('site_a', 3);
		s.record('site_b', 9);
		const ask = async (siteId: string, month: string) => {
			const message = await signCounts(
				{ siteId, hours: [], months: [month] },
				s.rig.clock.now(),
				s.rig.control.privateKey
			);
			return ((await (await s.post(message)).json()) as { months: { views: number }[] })
				.months;
		};
		expect(await ask('site_a', s.month)).toEqual([{ month: s.month, views: 3 }]);
		expect(await ask('site_b', s.month)).toEqual([{ month: s.month, views: 9 }]);
		expect(await ask('site_a', '2020-01')).toEqual([{ month: '2020-01', views: 0 }]);
		expect(s.reads).toEqual(['site_a', 'site_b', 'site_a']);
	});

	it('refuses a message signed with another key or for another context', async () => {
		const s = await setup();
		const wrongKey = await signCounts(
			{ siteId: 'site_a', hours: [], months: [s.month] },
			s.rig.clock.now(),
			s.rig.lease.privateKey
		);
		expect((await s.post(wrongKey)).status).toBe(403);
		// a spike message carries the same fields, signed under its own context
		const spike = await signSpike(
			{ op: 'counts', siteId: 'site_a', hours: [] },
			s.rig.clock.now(),
			s.rig.control.privateKey
		);
		const { op: _op, ...fields } = spike;
		const answer = await s.post({ ...fields, months: [s.month] });
		expect(answer.status).toBe(403);
		expect(await answer.json()).toEqual({ ok: false, code: 'bad_signature' });
		expect(COUNTS_CONTEXT).not.toBe('drupflare.dispatch.spike.v1');
		expect(s.reads).toEqual([]);
	});

	it('refuses a message edited after signing', async () => {
		const s = await setup();
		const message = await signCounts(
			{ siteId: 'site_a', hours: [], months: [s.month] },
			s.rig.clock.now(),
			s.rig.control.privateKey
		);
		expect((await s.post({ ...message, siteId: 'site_b' })).status).toBe(403);
		expect((await s.post({ ...message, months: ['2020-01'] })).status).toBe(403);
		expect(s.reads).toEqual([]);
	});

	it('refuses a stale or future message', async () => {
		const s = await setup();
		for (const skew of [-400_000, 400_000]) {
			const message = await signCounts(
				{ siteId: 'site_a', hours: [], months: [s.month] },
				s.rig.clock.now() + skew,
				s.rig.control.privateKey
			);
			const response = await s.post(message);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ ok: false, code: 'stale_message' });
		}
	});

	it('refuses malformed bodies with 400 and reads nothing', async () => {
		const s = await setup();
		const good = await signCounts(
			{ siteId: 'site_a', hours: [], months: [s.month] },
			s.rig.clock.now(),
			s.rig.control.privateKey
		);
		const bad = [
			{},
			{ ...good, v: 2 },
			{ ...good, extra: 1 },
			{ ...good, months: ['2026-13'] },
			{ ...good, months: ['nov'] },
			{ ...good, months: ['2026-01', '2026-02', '2026-03', '2026-04'] },
			{ ...good, hours: new Array(COUNTS_MAX_HOURS + 1).fill(0) },
			{ ...good, hours: [-1] },
			{ ...good, siteId: '' },
			{ ...good, sig: 'x' }
		];
		for (const body of bad) expect((await s.post(body)).status).toBe(400);
		const notJson = await serve(
			new Request(`https://${CONTROL}${COUNTS_PATH}`, { method: 'POST', body: '{' }),
			s.deps as never
		);
		expect(notJson.status).toBe(400);
		expect(s.reads).toEqual([]);
	});

	it('refuses a body over the size ceiling and any method but POST', async () => {
		const s = await setup();
		const large = await serve(
			new Request(`https://${CONTROL}${COUNTS_PATH}`, {
				method: 'POST',
				body: 'x'.repeat(5_000)
			}),
			s.deps as never
		);
		expect(large.status).toBe(413);
		expect((await s.post({}, 'GET')).status).toBe(405);
	});

	it('answers 503 when the counter object fails', async () => {
		const s = await setup();
		s.deps.counts = () => ({
			read: async () => {
				throw new Error('down');
			},
			month: async () => {
				throw new Error('down');
			}
		});
		const message = await signCounts(
			{ siteId: 'site_a', hours: [s.hour], months: [s.month] },
			s.rig.clock.now(),
			s.rig.control.privateKey
		);
		expect((await s.post(message)).status).toBe(503);
	});

	it('is a 404 on a deployment without the control key and for a tenant host', async () => {
		const s = await setup();
		const message = await signCounts(
			{ siteId: 'site_a', hours: [], months: [s.month] },
			s.rig.clock.now(),
			s.rig.control.privateKey
		);
		const unconfigured = { ...s.deps, controlKey: undefined };
		const response = await serve(
			new Request(`https://${CONTROL}${COUNTS_PATH}`, {
				method: 'POST',
				body: JSON.stringify(message)
			}),
			unconfigured as never
		);
		expect(response.status).toBe(404);
		expect((await s.post(message, 'POST', 'calm-river-stone.drupflare.app')).status).toBe(404);
	});

	it('verifies a message signed over the keys in another order', async () => {
		const s = await setup();
		const message = await signCounts(
			{ siteId: 'site_a', hours: [], months: [s.month] },
			s.rig.clock.now(),
			s.rig.control.privateKey
		);
		const reordered = Object.fromEntries(Object.entries(message).reverse());
		const result = await verifyCounts(reordered, s.rig.control.publicKey, s.rig.clock.now());
		expect(result.ok).toBe(true);
	});
});
