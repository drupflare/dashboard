import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	AuditHeadConflictError,
	append,
	appendBoth,
	canonicalJson,
	hashEntry,
	verify,
	type HeadStore
} from '../../../../src/server/services/audit';
import { fakeAuditDb, memoryHeads, type AuditRow, type MemoryHeads } from './audit-support';

const entry = {
	organization_id: 'org-1',
	seq: 0,
	actor: 'user-1',
	action: 'member.invite',
	target: 'invite-1',
	detail: '{}',
	created_at: 1_700_000_000_000
};

describe('canonicalJson', () => {
	it('sorts keys at every depth and drops undefined members', () => {
		const value = { b: 1, a: { d: [2, { z: null, y: 'x' }], c: undefined } };
		expect(canonicalJson(value)).toBe('{"a":{"d":[2,{"y":"x","z":null}]},"b":1}');
	});

	it('keeps array order', () => {
		expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
	});
});

describe('hashEntry', () => {
	it('is the sha256 of the previous hash followed by the canonical entry', async () => {
		const expected = createHash('sha256')
			.update('abc' + canonicalJson(entry))
			.digest('hex');
		expect(await hashEntry('abc', entry)).toBe(expected);
	});

	it('changes when the previous hash changes', async () => {
		expect(await hashEntry('a', entry)).not.toBe(await hashEntry('b', entry));
	});

	it('changes when an entry field changes', async () => {
		expect(await hashEntry('', entry)).not.toBe(
			await hashEntry('', { ...entry, actor: 'user-2' })
		);
	});
});

describe('chain head', () => {
	const ORG = 'org-1';
	const append3 = async (heads?: MemoryHeads) => {
		const rows: AuditRow[] = [];
		const db = fakeAuditDb(rows);
		for (const action of ['member.invite', 'key.create', 'site.delete']) {
			await append(db, ORG, { actor: 'user-1', action, target: 'x' }, heads);
		}
		return { rows, db };
	};

	it('records the length and newest hash after each append', async () => {
		const heads = memoryHeads();
		const { rows } = await append3(heads);
		expect(heads.writes.map((head) => head.length)).toEqual([1, 2, 3]);
		expect(heads.heads.get(ORG)).toMatchObject({ length: 3, hash: rows[2]!.hash });
	});

	it('records no head when no store is given', async () => {
		const heads = memoryHeads();
		const { db } = await append3();
		expect(heads.heads.size).toBe(0);
		expect(await verify(db, ORG)).toBeNull();
	});

	it('verifies an intact chain against its head', async () => {
		const heads = memoryHeads();
		const { db } = await append3(heads);
		expect(await verify(db, ORG, heads)).toBeNull();
	});

	it('verifies a chain with no head recorded yet and a chain longer than its head', async () => {
		const heads = memoryHeads();
		const { db, rows } = await append3(heads);
		heads.heads.set(ORG, { length: 2, hash: rows[1]!.hash, version: 'old' });
		expect(await verify(db, ORG, heads)).toBeNull();
		expect(await verify(db, ORG, memoryHeads())).toBeNull();
	});

	it('reports the first missing row when the newest rows are deleted', async () => {
		const heads = memoryHeads();
		const { db, rows } = await append3(heads);
		rows.pop();
		expect(await verify(db, ORG, heads)).toBe(2);
		rows.length = 0;
		expect(await verify(db, ORG, heads)).toBe(0);
	});

	it('reports the head position when the tail was rewritten with a consistent chain', async () => {
		const heads = memoryHeads();
		const { rows } = await append3(heads);
		const forged: AuditRow[] = rows.slice(0, 2);
		await append(fakeAuditDb(forged), ORG, {
			actor: 'user-9',
			action: 'site.delete',
			target: 'x'
		});
		expect(forged).toHaveLength(3);
		expect(await verify(fakeAuditDb(forged), ORG)).toBeNull();
		expect(await verify(fakeAuditDb(forged), ORG, heads)).toBe(2);
	});

	it('never moves the head backwards when a slow writer arrives late', async () => {
		const heads = memoryHeads();
		const { rows } = await append3(heads);
		const late = fakeAuditDb(rows.slice(0, 1));
		await append(late, ORG, { actor: 'user-1', action: 'x', target: 'x' }, heads);
		expect(heads.heads.get(ORG)?.length).toBe(3);
	});

	it('retries a head write that lost a race and gives up with a typed error', async () => {
		const heads = memoryHeads();
		let lose = 2;
		const flaky: HeadStore = {
			get: (org) => heads.get(org),
			put: async (org, head, expected) =>
				lose-- > 0 ? false : heads.put(org, head, expected)
		};
		await append(fakeAuditDb([]), ORG, { actor: 'u', action: 'a', target: 't' }, flaky);
		expect(heads.heads.get(ORG)?.length).toBe(1);

		const stuck: HeadStore = { get: async () => null, put: async () => false };
		await expect(
			append(fakeAuditDb([]), ORG, { actor: 'u', action: 'a', target: 't' }, stuck)
		).rejects.toBeInstanceOf(AuditHeadConflictError);
	});

	it('records both organisations on appendBoth', async () => {
		const heads = memoryHeads();
		const db = fakeAuditDb([]);
		await appendBoth(db, 'org-a', 'org-b', { actor: 'u', action: 'a', target: 't' }, heads);
		expect([...heads.heads.keys()].sort()).toEqual(['org-a', 'org-b']);
	});
});
