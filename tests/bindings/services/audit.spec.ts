import type { R2Bucket } from '@cloudflare/workers-types';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	AuditConflictError,
	append,
	appendBoth,
	r2HeadStore,
	verify,
	type HeadStore
} from '../../../src/server/services/audit';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	db = await ensureCollegeDB(withAtomicBatch(env));
});

afterAll(() => harness.close());

const input = (n: number) => ({
	actor: 'user-1',
	action: 'site.create',
	target: `site-${n}`,
	detail: { n }
});

const flipFirstChar = (column: string) =>
	`CASE WHEN substr(${column}, 1, 1) = '0' THEN '1' ELSE '0' END || substr(${column}, 2)`;

async function seededChain(length: number): Promise<string> {
	const organizationId = crypto.randomUUID();
	for (let n = 0; n < length; n++) {
		await append(db, organizationId, input(n));
	}
	return organizationId;
}

// removes the append-only trigger for one raw update, then restores the schema

async function tamper(sql: string, bindings: unknown[]): Promise<void> {
	await env.DB.prepare('DROP TRIGGER audit_log_no_update').run();
	try {
		await env.DB.prepare(sql)
			.bind(...bindings)
			.run();
	} finally {
		await applySchema(db);
	}
}

describe('audit append and verify', () => {
	it('links each entry to the one before and verifies an intact chain', async () => {
		const organizationId = await seededChain(5);
		const { results } = await env.DB.prepare(
			'SELECT seq FROM audit_log WHERE organization_id = ? ORDER BY seq'
		)
			.bind(organizationId)
			.all<{ seq: number }>();
		expect(results.map((row) => row.seq)).toEqual([0, 1, 2, 3, 4]);
		expect(await verify(db, organizationId)).toBeNull();
	});

	it('verifies a chain with no entries as intact', async () => {
		expect(await verify(db, crypto.randomUUID())).toBeNull();
	});

	it('verifies a chain longer than one page and finds a change on the second page', async () => {
		const organizationId = await seededChain(501);
		expect(await verify(db, organizationId)).toBeNull();
		await tamper(
			`UPDATE audit_log SET actor = 'user-2' WHERE organization_id = ? AND seq = 500`,
			[organizationId]
		);
		expect(await verify(db, organizationId)).toBe(500);
	});

	it('keeps one unbroken chain under four concurrent appends to the same organisation', async () => {
		const organizationId = crypto.randomUUID();
		await Promise.all([0, 1, 2, 3].map((n) => append(db, organizationId, input(n))));
		const { results } = await env.DB.prepare(
			'SELECT seq FROM audit_log WHERE organization_id = ? ORDER BY seq'
		)
			.bind(organizationId)
			.all<{ seq: number }>();
		expect(results.map((row) => row.seq)).toEqual([0, 1, 2, 3]);
		expect(await verify(db, organizationId)).toBeNull();
	});

	it.each([
		{
			name: 'a flipped byte in the detail of index 2',
			sql: `UPDATE audit_log SET detail = replace(detail, '"n":2', '"n":3')
			 WHERE organization_id = ? AND seq = 2`,
			broken: 2
		},
		{
			name: 'a flipped byte in the stored hash of index 3',
			sql: `UPDATE audit_log SET hash = ${flipFirstChar('hash')}
			 WHERE organization_id = ? AND seq = 3`,
			broken: 3
		},
		{
			name: 'a flipped byte in the link of index 1',
			sql: `UPDATE audit_log SET prev_hash = ${flipFirstChar('prev_hash')}
			 WHERE organization_id = ? AND seq = 1`,
			broken: 1
		},
		{
			name: 'a changed actor on the first entry',
			sql: `UPDATE audit_log SET actor = 'user-2' WHERE organization_id = ? AND seq = 0`,
			broken: 0
		}
	])('reports the first broken index for $name', async ({ sql, broken }) => {
		const organizationId = await seededChain(5);
		await tamper(sql, [organizationId]);
		expect(await verify(db, organizationId)).toBe(broken);
	});
});

describe('audit appendBoth', () => {
	it('writes the same action into two organisations, each with its own intact chain', async () => {
		const clientOrg = crypto.randomUUID();
		const agencyOrg = crypto.randomUUID();
		const [client, agency] = await appendBoth(db, clientOrg, agencyOrg, input(9));
		expect(client.organizationId).toBe(clientOrg);
		expect(agency.organizationId).toBe(agencyOrg);
		expect(client.hash).not.toBe(agency.hash);
		expect(await verify(db, clientOrg)).toBeNull();
		expect(await verify(db, agencyOrg)).toBeNull();
	});

	// counts the batches the client runs, and lets a test run code before the first one
	function watched(before?: () => Promise<void>) {
		const calls = { batch: 0, run: 0 };
		let first = true;
		const client = new Proxy(db, {
			get(target, name, receiver) {
				if (name === 'batch') {
					return async (entries: Parameters<typeof db.batch>[0]) => {
						calls.batch++;
						if (first && before) {
							first = false;
							await before();
						}
						return target.batch(entries);
					};
				}
				if (name === 'run') {
					return (...args: Parameters<typeof db.run>) => {
						calls.run++;
						return target.run(...args);
					};
				}
				return Reflect.get(target, name, receiver);
			}
		});
		return { client, calls };
	}

	it('writes both rows in one batch and not as two separate statements', async () => {
		const { client, calls } = watched();
		await appendBoth(client, crypto.randomUUID(), crypto.randomUUID(), input(1));
		expect(calls).toEqual({ batch: 1, run: 0 });
	});

	it('leaves neither row behind and retries both when one side loses a sequence race', async () => {
		const clientOrg = crypto.randomUUID();
		const agencyOrg = crypto.randomUUID();
		await append(db, clientOrg, input(0));
		// a rival takes the next seq of one chain after both were read and before the batch runs
		const { client, calls } = watched(async () => {
			await append(db, agencyOrg, input(100));
		});
		const [first, second] = await appendBoth(client, clientOrg, agencyOrg, input(1));
		expect(calls.batch).toBe(2);
		expect([first.seq, second.seq]).toEqual([1, 1]);
		for (const org of [clientOrg, agencyOrg]) {
			const { results } = await env.DB.prepare(
				'SELECT seq, target FROM audit_log WHERE organization_id = ? ORDER BY seq'
			)
				.bind(org)
				.all<{ seq: number; target: string }>();
			expect(results.map((row) => row.seq)).toEqual(results.map((_, index) => index));
			expect(await verify(db, org)).toBeNull();
		}
		const { results } = await env.DB.prepare(
			`SELECT count(*) AS n FROM audit_log WHERE organization_id IN (?, ?) AND target = 'site-1'`
		)
			.bind(clientOrg, agencyOrg)
			.all<{ n: number }>();
		expect(results[0]?.n).toBe(2);
	});

	it('records both chains in the head store', async () => {
		const heads = r2HeadStore(env.BLOB as unknown as R2Bucket);
		const clientOrg = crypto.randomUUID();
		const agencyOrg = crypto.randomUUID();
		await appendBoth(db, clientOrg, agencyOrg, input(2), heads);
		expect((await heads.get(clientOrg))?.length).toBe(1);
		expect((await heads.get(agencyOrg))?.length).toBe(1);
		expect(await verify(db, clientOrg, heads)).toBeNull();
	});

	it('appends twice to one chain when both names are the same organisation', async () => {
		const org = crypto.randomUUID();
		const [first, second] = await appendBoth(db, org, org, input(3));
		expect([first.seq, second.seq]).toEqual([0, 1]);
		expect(await verify(db, org)).toBeNull();
	});
});

// removes the append-only trigger for one raw delete, then restores the schema
async function deleteNewest(organizationId: string, count: number): Promise<void> {
	await env.DB.prepare('DROP TRIGGER audit_log_no_delete').run();
	try {
		await env.DB.prepare(
			`DELETE FROM audit_log WHERE organization_id = ?
			 AND seq > (SELECT max(seq) FROM audit_log WHERE organization_id = ?) - ?`
		)
			.bind(organizationId, organizationId, count)
			.run();
	} finally {
		await applySchema(db);
	}
}

describe('audit chain head in R2', () => {
	let heads: HeadStore;
	const bucket = () => env.BLOB as unknown as R2Bucket;

	beforeAll(() => {
		heads = r2HeadStore(bucket());
	});

	async function chain(length: number): Promise<string> {
		const organizationId = crypto.randomUUID();
		for (let n = 0; n < length; n++) await append(db, organizationId, input(n), heads);
		return organizationId;
	}

	it('records the length and newest hash after each append', async () => {
		const organizationId = await chain(3);
		const head = await heads.get(organizationId);
		const last = await env.DB.prepare(
			'SELECT hash FROM audit_log WHERE organization_id = ? AND seq = 2'
		)
			.bind(organizationId)
			.first<{ hash: string }>();
		expect(head).toMatchObject({ length: 3, hash: last?.hash });
		expect(head?.version).toEqual(expect.any(String));
		expect(await verify(db, organizationId, heads)).toBeNull();
	});

	it('returns null for an organisation with no head', async () => {
		expect(await heads.get(crypto.randomUUID())).toBeNull();
	});

	it('notices deleted newest rows that verify without the head accepts', async () => {
		const organizationId = await chain(4);
		await deleteNewest(organizationId, 2);
		expect(await verify(db, organizationId)).toBeNull();
		expect(await verify(db, organizationId, heads)).toBe(2);
	});

	it('finds the head position on the second page of a long chain', async () => {
		const organizationId = await chain(501);
		expect(await verify(db, organizationId, heads)).toBeNull();
		await deleteNewest(organizationId, 1);
		expect(await verify(db, organizationId, heads)).toBe(500);
	});

	it('keeps the head at the true length when four appends race', async () => {
		const organizationId = crypto.randomUUID();
		await Promise.all([0, 1, 2, 3].map((n) => append(db, organizationId, input(n), heads)));
		expect((await heads.get(organizationId))?.length).toBe(4);
		expect(await verify(db, organizationId, heads)).toBeNull();
	});

	it('writes only when the version still matches, and creates only when nothing exists', async () => {
		const organizationId = crypto.randomUUID();
		const head = { length: 1, hash: 'a'.repeat(64) };
		expect(await heads.put(organizationId, head, null)).toBe(true);
		expect(await heads.put(organizationId, head, null)).toBe(false);
		const stored = (await heads.get(organizationId))!;
		expect(await heads.put(organizationId, { ...head, length: 2 }, 'stale-etag')).toBe(false);
		expect(await heads.put(organizationId, { ...head, length: 2 }, stored.version)).toBe(true);
		expect((await heads.get(organizationId))?.length).toBe(2);
	});

	it('fails loudly on a head object that is not a head', async () => {
		const organizationId = crypto.randomUUID();
		await bucket().put(`audit-head/${organizationId}.json`, '{"length":0}');
		await expect(heads.get(organizationId)).rejects.toThrow();
	});
});

describe('audit append conflicts', () => {
	it('gives up with AuditConflictError when every attempt collides', async () => {
		const collides = {
			first: async () => null,
			run: async () => {
				throw new Error(
					'D1_ERROR: UNIQUE constraint failed: ' +
						'audit_log.organization_id, audit_log.seq: SQLITE_CONSTRAINT'
				);
			}
		} as unknown as CollegeDBClient;
		await expect(append(collides, crypto.randomUUID(), input(0))).rejects.toBeInstanceOf(
			AuditConflictError
		);
	});
});
