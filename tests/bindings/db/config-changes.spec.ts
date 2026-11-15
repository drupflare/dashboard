import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1ConfigLedger } from '../../../engine/src/adapters/config-changes';
import type { ConfigChangeRecord } from '../../../engine/src/ports';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	getConfigChange,
	listConfigChanges,
	listOperationChanges
} from '../../../src/server/db/repos/config-changes';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: Awaited<ReturnType<typeof ensureCollegeDB>>;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	db = await ensureCollegeDB(withAtomicBatch(env));
});

afterAll(() => harness.close());

const ORG = 'org_cfgbind0001';
const OTHER = 'org_cfgbind0002';
const SITE = 'site_cfgbind0001';
const NOW = 1_790_000_000_000;

const row = (key: string, over: Partial<ConfigChangeRecord> = {}): ConfigChangeRecord => ({
	id: `cfg_op_a_${key}`,
	organizationId: ORG,
	siteId: SITE,
	operationId: 'op_a',
	key,
	before: JSON.stringify({ value: null, source: 'default' }),
	after: '"1"',
	actor: 'user:u1',
	status: 'pending',
	createdAt: NOW,
	revertedBy: null,
	...over
});

describe('site config changes', () => {
	it('keeps the first reading when the same rows are begun again', async () => {
		const ledger = new D1ConfigLedger(env.DB);
		await ledger.begin([row('SPOOL')]);
		await ledger.begin([row('SPOOL', { before: '{"value":"x","source":"kv"}' })]);
		const kept = await ledger.forOperation(ORG, 'op_a');
		expect(kept).toHaveLength(1);
		expect(JSON.parse(kept[0]!.before)).toEqual({ value: null, source: 'default' });
	});

	it('settles pending rows once and never moves a settled row', async () => {
		const ledger = new D1ConfigLedger(env.DB);
		await ledger.begin([
			row('SPOOL_IMAGES', { operationId: 'op_b', id: 'cfg_op_b_SPOOL_IMAGES' })
		]);
		await ledger.settle(ORG, 'op_b', 'applied');
		await ledger.settle(ORG, 'op_b', 'failed');
		expect((await ledger.forOperation(ORG, 'op_b'))[0]?.status).toBe('applied');
		await ledger.settle(OTHER, 'op_b', 'unverified');
		expect((await ledger.forOperation(ORG, 'op_b'))[0]?.status).toBe('applied');
	});

	it('marks a row reverted once, by the first revert', async () => {
		const ledger = new D1ConfigLedger(env.DB);
		await ledger.begin([
			row('SPOOL_VIDEO', { operationId: 'op_c', id: 'cfg_op_c_SPOOL_VIDEO' })
		]);
		await ledger.markReverted(ORG, ['cfg_op_c_SPOOL_VIDEO'], 'op_r1');
		await ledger.markReverted(ORG, ['cfg_op_c_SPOOL_VIDEO'], 'op_r2');
		await ledger.markReverted(ORG, [], 'op_r3');
		expect((await getConfigChange(db, ORG, SITE, 'cfg_op_c_SPOOL_VIDEO'))?.revertedBy).toBe(
			'op_r1'
		);
	});

	it('reads one change only inside its own organisation and site', async () => {
		expect(await getConfigChange(db, ORG, SITE, 'cfg_op_a_SPOOL')).toMatchObject({
			key: 'SPOOL'
		});
		expect(await getConfigChange(db, OTHER, SITE, 'cfg_op_a_SPOOL')).toBeNull();
		expect(await getConfigChange(db, ORG, 'site_other', 'cfg_op_a_SPOOL')).toBeNull();
	});

	it('lists newest first, pages by cursor and filters by key before the page is cut', async () => {
		const ledger = new D1ConfigLedger(env.DB);
		await ledger.begin(
			['A_KEY', 'B_KEY', 'C_KEY'].map((key, i) =>
				row(key, { operationId: 'op_d', id: `cfg_op_d_${key}`, createdAt: NOW + 1000 + i })
			)
		);
		const all = await listConfigChanges(db, ORG, SITE, {
			count: 100,
			keys: ['A_KEY', 'C_KEY']
		});
		expect(all.map((r) => r.key)).toEqual(['C_KEY', 'A_KEY']);
		const first = await listConfigChanges(db, ORG, SITE, {
			count: 1,
			keys: ['A_KEY', 'C_KEY']
		});
		const next = await listConfigChanges(db, ORG, SITE, {
			count: 1,
			keys: ['A_KEY', 'C_KEY'],
			after: { createdAt: first[0]!.createdAt, id: first[0]!.id }
		});
		expect([first[0]?.key, next[0]?.key]).toEqual(['C_KEY', 'A_KEY']);
		expect(await listConfigChanges(db, ORG, SITE, { count: 10, keys: [] })).toEqual([]);
		expect((await listConfigChanges(db, ORG, SITE, { count: 100 })).length).toBeGreaterThan(3);
		expect(await listConfigChanges(db, OTHER, SITE, { count: 100 })).toEqual([]);
	});

	it('lists every key of one operation in key order', async () => {
		const keys = (await listOperationChanges(db, ORG, SITE, 'op_d')).map((r) => r.key);
		expect(keys).toEqual(['A_KEY', 'B_KEY', 'C_KEY']);
	});
});
