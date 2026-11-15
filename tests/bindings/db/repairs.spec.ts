import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1RepairLedger } from '../../../engine/src/adapters/repair';
import { repairRecordId } from '../../../engine/src/repair/rows';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	clearLadderSwitch,
	getLadderSwitches,
	setLadderSwitch
} from '../../../src/server/db/repos/ladder-switches';
import {
	getRepair,
	listActiveSites,
	listRepairs,
	repairHistory,
	repairsSince
} from '../../../src/server/db/repos/repairs';
import { autoRepairOn } from '../../../src/server/domain/incidents';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: ReturnType<typeof createCollegeDB>;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	db = await ensureCollegeDB(withAtomicBatch(env));
});

afterAll(() => harness.close());

const ORG = 'org_repairbind01';
const OTHER = 'org_repairbind02';
const SITE = 'site_repairbind01';
const NOW = 1_790_000_000_000;

let counter = 0;
const operationId = () => `op_${`${++counter}`.padStart(26, 'p')}`;

const begin = (patch: Partial<Parameters<D1RepairLedger['begin']>[0]> & { at?: number } = {}) => {
	const id = patch.operationId ?? operationId();
	return new D1RepairLedger(env.DB).begin({
		id: patch.id ?? repairRecordId(id),
		organizationId: ORG,
		siteId: SITE,
		repairId: 'render.empty',
		rung: 'observe',
		status: 'running',
		observationBefore: '{"reading":{}}',
		operationId: id,
		undoOf: null,
		createdAt: patch.at ?? NOW,
		finishedAt: null,
		...patch
	});
};

describe('repairs', () => {
	it('reads back a row the engine wrote, with both observations as stored text', async () => {
		const ledger = new D1RepairLedger(env.DB);
		const row = await begin({ at: NOW });
		await ledger.finish(ORG, row.id, {
			status: 'succeeded',
			observationAfter: '{"predicate":{"cleared":true}}',
			finishedAt: NOW + 5
		});
		expect(await getRepair(db, ORG, row.id)).toEqual({
			...row,
			status: 'succeeded',
			observationAfter: '{"predicate":{"cleared":true}}',
			finishedAt: NOW + 5
		});
		expect(await getRepair(db, OTHER, row.id)).toBeNull();
	});

	it('keeps the first row when an id is written twice, and ends a row only once', async () => {
		const ledger = new D1RepairLedger(env.DB);
		const first = await begin({ at: NOW + 10, observationBefore: '{"first":true}' });
		const second = await begin({ id: first.id, observationBefore: '{"second":true}' });
		expect(second.observationBefore).toBe('{"first":true}');
		await ledger.finish(ORG, first.id, {
			status: 'failed',
			observationAfter: '{"a":1}',
			finishedAt: NOW + 20
		});
		await ledger.finish(ORG, first.id, {
			status: 'succeeded',
			observationAfter: '{"a":2}',
			finishedAt: NOW + 30
		});
		const stored = await getRepair(db, ORG, first.id);
		expect(stored).toMatchObject({ status: 'failed', observationAfter: '{"a":1}' });
		await ledger.undone(ORG, first.id);
		expect((await getRepair(db, ORG, first.id))!.status).toBe('failed');
	});

	it('marks only a succeeded repair as undone', async () => {
		const ledger = new D1RepairLedger(env.DB);
		const row = await begin({ at: NOW + 40 });
		await ledger.finish(ORG, row.id, {
			status: 'succeeded',
			observationAfter: '{}',
			finishedAt: NOW + 41
		});
		await ledger.undone(ORG, row.id);
		expect((await getRepair(db, ORG, row.id))!.status).toBe('undone');
	});

	it('lists a site newest first and pages by time and id', async () => {
		const site = 'site_repairbind02';
		for (let n = 0; n < 5; n++) await begin({ siteId: site, at: NOW + 100 + n });
		const first = await listRepairs(db, ORG, site, { count: 2 });
		expect(first.map((r) => r.createdAt)).toEqual([NOW + 104, NOW + 103]);
		const last = first.at(-1)!;
		const next = await listRepairs(db, ORG, site, {
			count: 10,
			after: { createdAt: last.createdAt, id: last.id }
		});
		expect(next.map((r) => r.createdAt)).toEqual([NOW + 102, NOW + 101, NOW + 100]);
		expect(await listRepairs(db, OTHER, site, { count: 10 })).toEqual([]);
	});

	it('returns the attempts of one repair on one site newest first', async () => {
		const site = 'site_repairbind03';
		await begin({ siteId: site, repairId: 'reconcile', at: NOW + 200 });
		await begin({ siteId: site, repairId: 'render.empty', at: NOW + 201 });
		await begin({ siteId: site, repairId: 'reconcile', at: NOW + 202 });
		const history = await repairHistory(db, ORG, site, 'reconcile', 5);
		expect(history.map((r) => r.createdAt)).toEqual([NOW + 202, NOW + 200]);
		const viaEngine = await new D1RepairLedger(env.DB).history(ORG, site, 'reconcile', 5);
		expect(viaEngine).toEqual(history);
		expect(await repairHistory(db, ORG, site, 'reconcile', 1)).toHaveLength(1);
	});

	it('counts the repairs begun in a window and skips a refused one', async () => {
		const site = 'site_repairbind04';
		await begin({ siteId: site, at: NOW + 1_000_000 });
		await begin({ siteId: site, at: NOW + 1_000_001, status: 'refused', finishedAt: NOW });
		await begin({ siteId: site, at: NOW + 1_000_002, organizationId: OTHER });
		const spent = await repairsSince(db, NOW + 1_000_000);
		expect(spent).toEqual(
			expect.arrayContaining([
				{ orgId: ORG, atMs: NOW + 1_000_000 },
				{ orgId: OTHER, atMs: NOW + 1_000_002 }
			])
		);
		expect(spent.some((s) => s.atMs === NOW + 1_000_001)).toBe(false);
		expect(await new D1RepairLedger(env.DB).since(NOW + 1_000_000)).toEqual(spent);
	});

	it('refuses an unknown status and a missing observation', async () => {
		await expect(
			env.DB.prepare(
				`INSERT INTO repairs (id, organization_id, site_id, repair_id, rung, status,
				observation_before, operation_id, created_at) VALUES ('r1', ?, ?, 'x', 'observe', 'lost', '{}', 'op', 1)`
			)
				.bind(ORG, SITE)
				.run()
		).rejects.toThrow(/CHECK/);
		await expect(
			env.DB.prepare(
				`INSERT INTO repairs (id, organization_id, site_id, repair_id, rung, status,
				observation_before, operation_id, created_at) VALUES ('r2', ?, ?, 'x', 'observe', 'running', NULL, 'op', 1)`
			)
				.bind(ORG, SITE)
				.run()
		).rejects.toThrow(/NOT NULL/);
	});
});

describe('active sites', () => {
	it('lists live, ready sites that hold a hostname, and no others', async () => {
		const add = (id: string, state: string, host: string | null, ready: number | null) =>
			env.DB.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, ready_at, created_at, updated_at)
				 VALUES (?, ?, ?, 'managed', ?, ?, ?, ?, ?)`
			)
				.bind(id, ORG, id, state, host, ready, NOW, NOW)
				.run();
		await add('site_repairlive01', 'active', 'one.example.org', NOW);
		await add('site_repairlive02', 'suspended', 'two.example.org', NOW);
		await add('site_repairlive03', 'active', null, NOW);
		await add('site_repairlive04', 'active', 'four.example.org', null);
		const live = await listActiveSites(db);
		expect(live.filter((site) => site.id.startsWith('site_repairlive'))).toEqual([
			{ id: 'site_repairlive01', organizationId: ORG }
		]);
	});
});

describe('ladder switches', () => {
	const set = (scope: 'global' | 'organization' | 'site', scopeId: string, auto: boolean) =>
		setLadderSwitch(db, { scope, scopeId, auto, updatedBy: 'user:u1', now: NOW });

	it('reads an unset switch as unset, which autoRepairOn reads as off', async () => {
		const none = await getLadderSwitches(db, 'org_unset', 'site_unset');
		expect(none).toEqual({ global: undefined });
		expect(autoRepairOn(none)).toBe(false);
	});

	it('stores the global, organisation and site levels apart', async () => {
		await set('global', 'ignored', true);
		await set('organization', ORG, false);
		await set('site', SITE, true);
		expect(await getLadderSwitches(db, ORG, SITE)).toEqual({
			global: true,
			org: false,
			site: true
		});
		expect(await getLadderSwitches(db, OTHER, SITE)).toEqual({ global: true, site: true });
		expect(await getLadderSwitches(db, OTHER, 'site_other')).toEqual({ global: true });
		expect(autoRepairOn(await getLadderSwitches(db, ORG, SITE))).toBe(false);
		expect(autoRepairOn(await getLadderSwitches(db, OTHER, 'site_other'))).toBe(true);
	});

	it('updates a level in place and lets the engine read what the dashboard wrote', async () => {
		await set('organization', ORG, true);
		await set('global', '', false);
		const viaDashboard = await getLadderSwitches(db, ORG, SITE);
		expect(viaDashboard).toEqual({ global: false, org: true, site: true });
		expect(await new D1RepairLedger(env.DB).switches(ORG, SITE)).toEqual(viaDashboard);
		const rows = await env.DB.prepare(
			`SELECT updated_by FROM ladder_switches WHERE scope = 'global'`
		).all<{ updated_by: string }>();
		expect(rows.results).toEqual([{ updated_by: 'user:u1' }]);
	});

	it('clears a level back to unset', async () => {
		await clearLadderSwitch(db, 'site', SITE);
		expect((await getLadderSwitches(db, ORG, SITE)).site).toBeUndefined();
		await clearLadderSwitch(db, 'global', 'ignored');
		expect((await getLadderSwitches(db, ORG, SITE)).global).toBeUndefined();
	});

	it('refuses a scope outside the three levels', async () => {
		await expect(
			env.DB.prepare(
				`INSERT INTO ladder_switches (scope, scope_id, auto, updated_at, updated_by) VALUES ('fleet', 'x', 1, 1, 'u')`
			).run()
		).rejects.toThrow(/CHECK/);
	});
});
