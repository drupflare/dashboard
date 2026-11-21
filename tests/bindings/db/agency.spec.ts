import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateRowError, ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	findDelegationBatch,
	findTransfer,
	insertTransfer,
	listDelegationsReceived,
	listTransfersIn,
	listTransfersOut,
	recordStep,
	stepsDone
} from '../../../src/server/db/repos/agency';
import { createUser } from '../../../src/server/db/repos/identity';
import { createDelegation, createOrganization } from '../../../src/server/db/repos/organization';
import type { Transfer } from '../../../src/server/domain/transfer';
import { openBindings, TWO_SHARD_CONFIG, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings(TWO_SHARD_CONFIG);
	env = harness.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => harness.close());

const tag = () => crypto.randomUUID().replaceAll('-', '');

async function org(name: string, createdBy: string): Promise<string> {
	const created = await createOrganization(db, { name, personal: false, createdBy });
	return created.id;
}

function transferBetween(fromOrgId: string, toOrgId: string, siteId: string): Transfer {
	return {
		id: `tr_${tag()}`,
		siteId,
		fromOrgId,
		toOrgId,
		state: 'proposed',
		keepDelegationId: null,
		proposedBy: 'usr_owner',
		proposedAt: 1_800_000_000_000,
		expiresAt: 1_800_000_000_000 + 14 * 24 * 60 * 60 * 1000,
		decidedBy: null,
		decidedAt: null
	};
}

describe('agency reads across shards', () => {
	it('finds a transfer by id and lists it from both sides', async () => {
		const from = await org('Source', 'usr_a');
		const to = await org('Target', 'usr_b');
		const site = `site_${tag().slice(0, 8)}`;
		const t = transferBetween(from, to, site);
		await insertTransfer(db, t);

		expect(await findTransfer(db, t.id)).toMatchObject({
			id: t.id,
			fromOrgId: from,
			toOrgId: to
		});
		expect((await listTransfersOut(db, from)).map((row) => row.id)).toContain(t.id);
		expect((await listTransfersIn(db, to)).map((row) => row.id)).toContain(t.id);
		expect(await findTransfer(db, `tr_missing_${tag()}`)).toBeNull();
	});

	it('refuses a second open proposal for the same site', async () => {
		const from = await org('Source two', 'usr_a');
		const to = await org('Target two', 'usr_b');
		const site = `site_${tag().slice(0, 8)}`;
		await insertTransfer(db, transferBetween(from, to, site));
		await expect(insertTransfer(db, transferBetween(from, to, site))).rejects.toBeInstanceOf(
			DuplicateRowError
		);
	});

	it('records each completion step once, and a repeat is ignored', async () => {
		const from = await org('Source steps', 'usr_a');
		const to = await org('Target steps', 'usr_b');
		const t = transferBetween(from, to, `site_${tag().slice(0, 8)}`);
		await insertTransfer(db, t);
		await recordStep(db, t, 'ownership', 1);
		await recordStep(db, t, 'ownership', 2);
		await recordStep(db, t, 'billing', 3);
		expect((await stepsDone(db, t)).sort()).toEqual(['billing', 'ownership']);
	});

	it('finds every row of a delegation batch by its batch id alone, and lists it for the agency', async () => {
		const client = await org('Client', 'usr_a');
		const agency = await org('Agency', 'usr_b');
		const user = await createUser(db, { email: `owner-${tag()}@example.test` });
		const batchId = `batch_${tag()}`;
		for (const siteId of ['site_one', 'site_two']) {
			await createDelegation(db, client, {
				agencyOrganizationId: agency,
				role: 'viewer',
				siteId,
				createdBy: user.id,
				expiresAt: null,
				batchId
			});
		}
		const rows = await findDelegationBatch(db, batchId);
		expect(rows.map((row) => row.siteId).sort()).toEqual(['site_one', 'site_two']);
		expect((await listDelegationsReceived(db, agency)).map((row) => row.batchId)).toEqual(
			expect.arrayContaining([batchId])
		);
	});
});
