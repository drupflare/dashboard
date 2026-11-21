import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import { BATCH_WINDOW_MS } from '../../../contracts/src/engine-batch';
import { D1ReplayStore, buildBatchDeps } from '../../../engine/src/batch-env';
import type { EngineEnv } from '../../../engine/src/env';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { collegeStateLedger } from '../../../src/server/db/repos/budget-states';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	db = await ensureCollegeDB(open.env as Bindings);
});

afterAll(() => open.close());

const siteId = () => `site_${crypto.randomUUID()}`;

describe('the budget state ledger', () => {
	it('records the last state and threshold written for a site and reads it back', async () => {
		const ledger = collegeStateLedger(
			async () => db,
			() => 5_000
		);
		const id = siteId();
		expect(await ledger.get(id)).toBeNull();
		await ledger.set(id, { state: 'ok', reason: null, mode: 'on', blockAtViews: 900 });
		expect(await ledger.get(id)).toEqual({
			state: 'ok',
			reason: null,
			mode: 'on',
			blockAtViews: 900,
			writtenAt: 5_000
		});
	});

	it('replaces the row on the next write and keeps the time it was given', async () => {
		const ledger = collegeStateLedger(
			async () => db,
			() => 5_000
		);
		const id = siteId();
		await ledger.set(id, { state: 'ok', reason: null, mode: 'shadow', blockAtViews: 10 });
		await ledger.set(id, {
			state: 'over-budget',
			reason: 'org-budget',
			mode: 'on',
			blockAtViews: null,
			writtenAt: 9_000
		});
		expect(await ledger.get(id)).toEqual({
			state: 'over-budget',
			reason: 'org-budget',
			mode: 'on',
			blockAtViews: null,
			writtenAt: 9_000
		});
	});

	it('reads many sites in one call, over the chunk size, and leaves out the unknown ones', async () => {
		const ledger = collegeStateLedger(
			async () => db,
			() => 1
		);
		const ids = Array.from({ length: 120 }, siteId);
		for (const id of ids.slice(0, 60)) {
			await ledger.set(id, { state: 'ok', reason: null, mode: 'on', blockAtViews: 1 });
		}
		const found = await ledger.getMany!(ids);
		expect(found.size).toBe(60);
		expect(found.has(ids[0]!)).toBe(true);
		expect(found.has(ids[100]!)).toBe(false);
	});
});

describe('the engine replay store', () => {
	it('claims an id once and refuses it after', async () => {
		const store = new D1ReplayStore(open.env.DB as never);
		const id = `budget:req_${crypto.randomUUID()}`;
		expect(await store.claim(id, 1_000_000)).toBe(true);
		expect(await store.claim(id, 1_000_001)).toBe(false);
	});

	it('lets two copies of one request race and lets one win', async () => {
		const store = new D1ReplayStore(open.env.DB as never);
		const id = `counts:req_${crypto.randomUUID()}`;
		const wins = await Promise.all([store.claim(id, 2_000_000), store.claim(id, 2_000_000)]);
		expect(wins.filter(Boolean)).toHaveLength(1);
	});

	it('prunes ids older than twice the window and keeps newer ones', async () => {
		const store = new D1ReplayStore(open.env.DB as never);
		const old = `budget:req_${crypto.randomUUID()}`;
		const recent = `budget:req_${crypto.randomUUID()}`;
		const start = 10_000_000;
		await store.claim(old, start);
		await store.claim(recent, start + BATCH_WINDOW_MS);
		await store.claim(`budget:req_${crypto.randomUUID()}`, start + 2 * BATCH_WINDOW_MS + 1);
		expect(await store.claim(old, start + 2 * BATCH_WINDOW_MS + 2)).toBe(true);
		expect(await store.claim(recent, start + 2 * BATCH_WINDOW_MS + 2)).toBe(false);
	});
});

describe('the batch wiring', () => {
	it('reads counts from the USAGE_COUNTER binding when no control URL is configured', async () => {
		const asked: string[] = [];
		const env = {
			CONTROL_SEED: toBase64Url(crypto.getRandomValues(new Uint8Array(32))),
			BUDGET_SECRET: 'budget-secret-'.repeat(3),
			COUNTS_SECRET: 'counts-secret-'.repeat(3),
			START_SECRET: 'start-secret-'.repeat(3),
			DB: {},
			SITE_AUTH: {},
			USAGE_COUNTER: {
				idFromName: (name: string) => name,
				get(id: string) {
					asked.push(id);
					return { read: async () => null, month: async () => 5 };
				}
			}
		} as unknown as EngineEnv;
		const deps = await buildBatchDeps(env);
		expect(await deps.counts({ siteId: 'site_a', hours: [], months: ['2026-11'] })).toEqual({
			ok: true,
			hours: [],
			months: [{ month: '2026-11', views: 5 }]
		});
		expect(asked).toEqual(['site_a']);
	});
});
