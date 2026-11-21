import type { CollegeDBClient } from '@earth-app/collegedb';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../../../src/server/domain/authorize';
import { hashApiKey } from '../../../../src/server/services/api-keys';
import {
	ACTIVE_KEY_BOUND,
	issueKey,
	listKeys,
	revokeKey,
	type KeyServices
} from '../../../../src/server/services/key-admin';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { sqliteClient } from '../fixtures/sqlite-client';

const owner: Principal = { kind: 'user', userId: 'user-1' };
const body = { name: 'ci', scopes: ['org.read', 'site.read'], expiry: '90d' } as const;

interface World {
	raw: ReturnType<typeof sqliteClient>['raw'];
	trail: { orgId: string; action: string; target: string }[];
	services: KeyServices;
	fail: { audit: boolean };
}

function world(): World {
	const { raw, client } = sqliteClient();
	const trail: World['trail'] = [];
	const fail = { audit: false };
	const services: KeyServices = {
		getDb: async () => client as unknown as CollegeDBClient,
		audit: async (orgId, input) => {
			if (fail.audit) throw new Error('audit is down');
			trail.push({ orgId, action: input.action, target: input.target });
		},
		now: () => 1_700_000_000_000
	};
	return { raw, trail, services, fail };
}

function insertKey(w: World, id: string, org = ORG, revokedAt: number | null = null) {
	w.raw
		.prepare(
			`INSERT INTO api_keys (id, organization_id, name, key_hash, scopes, created_by,
			 expires_at, revoked_at, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			id,
			org,
			`key ${id}`,
			`hash-${id}`,
			'["org.read"]',
			'user-1',
			null,
			revokedAt,
			1,
			null
		);
	w.raw
		.prepare('INSERT INTO api_key_lookup (lookup_id, organization_id, key_id) VALUES (?, ?, ?)')
		.run(`lookup${id}`, org, id);
}

const asOwner = (w: World, over: Partial<Parameters<typeof issueKey>[1]> = {}) =>
	issueKey(w.services, {
		orgId: ORG,
		userId: 'user-1',
		principal: owner,
		facts: facts({ ...member('owner'), ...fresh }),
		body,
		...over
	} as Parameters<typeof issueKey>[1]);

describe('issueKey', () => {
	it('returns the token once, stores only its hash, and audits the issue', async () => {
		const w = world();
		const created = await asOwner(w);
		expect(created.token).toMatch(/^dfk_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/);
		const [stored] = w.raw.prepare('SELECT * FROM api_keys').all() as Record<string, unknown>[];
		expect(stored).toMatchObject({
			id: created.id,
			organization_id: ORG,
			key_hash: await hashApiKey(created.token),
			created_by: 'user-1'
		});
		expect(JSON.stringify(stored)).not.toContain(created.token);
		expect(w.trail).toEqual([{ orgId: ORG, action: 'key.issued', target: created.id }]);
	});

	it('refuses a permission the issuer does not hold, and writes nothing', async () => {
		const w = world();
		await expect(
			asOwner(w, {
				facts: facts({ ...member('viewer'), ...fresh }),
				body: { name: 'ci', scopes: ['member.invite'], expiry: '90d' }
			})
		).rejects.toMatchObject({ code: 'forbidden', details: { reason: 'exceeds_issuer' } });
		expect(w.raw.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({ n: 0 });
	});

	it('refuses an empty scope list as a validation error', async () => {
		const w = world();
		await expect(
			asOwner(w, { body: { name: 'ci', scopes: [], expiry: '90d' } })
		).rejects.toMatchObject({ code: 'validation', details: { reason: 'empty' } });
	});

	it('refuses the key that would pass the organisation bound', async () => {
		const w = world();
		for (let i = 0; i < ACTIVE_KEY_BOUND; i++) insertKey(w, `k${i}`);
		await expect(asOwner(w)).rejects.toMatchObject({
			code: 'conflict',
			details: { reason: 'key_bound' }
		});
		expect(w.raw.prepare('SELECT COUNT(*) AS n FROM api_keys').get()).toEqual({
			n: ACTIVE_KEY_BOUND
		});
	});

	it('revokes the key it just wrote when the audit row cannot be written', async () => {
		const w = world();
		w.fail.audit = true;
		await expect(asOwner(w)).rejects.toThrow('audit is down');
		const [stored] = w.raw.prepare('SELECT revoked_at FROM api_keys').all() as {
			revoked_at: number | null;
		}[];
		expect(stored?.revoked_at).not.toBeNull();
	});
});

describe('listKeys', () => {
	it('lists the keys of one organisation with their display prefix and pages by cursor', async () => {
		const w = world();
		insertKey(w, 'k-a');
		insertKey(w, 'k-b');
		insertKey(w, 'k-other', OTHER_ORG);
		const first = await listKeys(w.services, ORG, { limit: 1 });
		expect(first.items).toHaveLength(1);
		expect(first.nextCursor).not.toBeNull();
		const all = await listKeys(w.services, ORG, { limit: 5 });
		expect(all.items.map((item) => item.id).sort()).toEqual(['k-a', 'k-b']);
		expect(all.items.find((item) => item.id === 'k-a')).toMatchObject({
			prefix: 'dfk_lookupk-a'
		});
	});
});

describe('revokeKey', () => {
	it('sets the revocation once and returns the same instant on a repeat', async () => {
		const w = world();
		insertKey(w, 'k-a');
		const first = await revokeKey(w.services, ORG, 'k-a');
		expect(first.revokedAt).not.toBeNull();
		const again = await revokeKey(w.services, ORG, 'k-a');
		expect(again.revokedAt).toBe(first.revokedAt);
	});

	it('refuses a key that belongs to another organisation, and leaves it alone', async () => {
		const w = world();
		insertKey(w, 'k-other', OTHER_ORG);
		await expect(revokeKey(w.services, ORG, 'k-other')).rejects.toMatchObject({
			code: 'not_found'
		});
		const [row] = w.raw.prepare('SELECT revoked_at FROM api_keys').all() as {
			revoked_at: number | null;
		}[];
		expect(row?.revoked_at).toBeNull();
	});
});
