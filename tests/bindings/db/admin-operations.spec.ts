import type { D1Database } from '@cloudflare/workers-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_BUDGET } from '../../../contracts/src/operations';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { adminWork, listAdminOperations } from '../../../src/server/db/repos/admin';
import { createOperationRecord } from '../../../src/server/db/repos/backups';
import { type Bindings, type OpenBindings, openBindings, TWO_SHARD_CONFIG } from '../support';

const NOW = 1_700_000_000_000;

async function countOn(database: D1Database): Promise<number> {
	const row = await database
		.prepare('SELECT COUNT(*) AS n FROM operations')
		.first<{ n: number }>();
	return row?.n ?? 0;
}

describe('the admin reason for a failed operation on two shards', () => {
	let harness: OpenBindings;
	let env: Bindings;

	beforeAll(async () => {
		harness = await openBindings(TWO_SHARD_CONFIG);
		env = harness.env;
	});

	afterAll(() => harness.close());

	it('finds the failed step beside its operation on whichever shard the organization lives', async () => {
		const db = await ensureCollegeDB(env);
		const orgs = Array.from({ length: 30 }, () => crypto.randomUUID());
		for (const org of orgs) {
			await createOperationRecord(db, {
				id: `op_${org}`,
				organizationId: org,
				accountId: null,
				siteId: null,
				type: 'site.create',
				status: 'failed',
				idempotencyKey: `key-${org}`,
				targetIds: [],
				preconditions: [],
				planDigest: 'digest',
				blastRadius: { sites: 1, destructiveSites: 0, productionDeploys: 0 },
				rollbackPoint: null,
				verification: 'pending',
				budget: DEFAULT_CHANGE_BUDGET,
				steps: [
					{ id: 'lease', name: 'Take the lease' },
					{ id: 'verify', name: 'Check the site' }
				],
				now: NOW
			});
			await db.run(
				org,
				`UPDATE operation_steps SET state = 'failed' WHERE operation_id = ? AND id = 'verify'`,
				[`op_${org}`]
			);
		}
		expect(await countOn(env.DB)).toBeGreaterThan(0);
		expect(await countOn(env.DB_2 as D1Database)).toBeGreaterThan(0);

		const page = await listAdminOperations(db, { limit: 100 });
		expect(page.items).toHaveLength(30);
		for (const item of page.items) {
			expect(item.reason).toBe('Stopped while checking that the site answers.');
		}

		const work = await adminWork(db, NOW);
		expect(work.recentFailures).toHaveLength(20);
		for (const failure of work.recentFailures) {
			expect(failure.reason).toBe('Stopped while checking that the site answers.');
		}
		expect(work.failedLastDay).toBe(30);
	});
});
