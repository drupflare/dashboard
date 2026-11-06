import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuplicateRowError, ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	acceptDelegation,
	addMember,
	createApiKey,
	createDelegation,
	createInvite,
	createOrganization,
	createSiteGrant,
	getApiKeyByHash,
	getDelegation,
	getInvite,
	getMember,
	getOrganization,
	getSiteGrant,
	listMembers,
	listUserOrganizations,
	type OrganizationCursor,
	OrganizationListError,
	revokeApiKey,
	revokeDelegation,
	revokeSiteGrant,
	setInviteState,
	setMemberRole
} from '../../../src/server/db/repos/organization';
import type { OrganizationRole } from '../../../src/server/db/schema';
import { type Bindings, type OpenBindings, openBindings, TWO_SHARD_CONFIG } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => harness.close());

async function newOrganization(): Promise<string> {
	const org = await createOrganization(db, {
		name: 'Test Org',
		personal: false,
		createdBy: crypto.randomUUID()
	});
	return org.id;
}

describe('organization repository', () => {
	it('creates an organisation and reads it back', async () => {
		const created = await createOrganization(db, {
			name: 'Personal',
			personal: true,
			createdBy: 'user-1'
		});
		expect(await getOrganization(db, created.id)).toEqual(created);
		expect(created.personal).toBe(true);
		expect(await getOrganization(db, crypto.randomUUID())).toBeNull();
	});
});

describe('member repository', () => {
	it('adds a member and refuses a second membership of the same user', async () => {
		const orgId = await newOrganization();
		const userId = crypto.randomUUID();
		const member = await addMember(db, orgId, { userId, role: 'developer' });
		expect(await getMember(db, orgId, userId)).toEqual(member);
		await expect(addMember(db, orgId, { userId, role: 'viewer' })).rejects.toBeInstanceOf(
			DuplicateRowError
		);
	});

	it('pages members with a cursor so each one is listed once', async () => {
		const orgId = await newOrganization();
		const added = [];
		for (let i = 0; i < 5; i++) {
			added.push(
				(await addMember(db, orgId, { userId: crypto.randomUUID(), role: 'viewer' })).id
			);
		}
		const seen: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await listMembers(db, orgId, { after: cursor, limit: 2 });
			seen.push(...page.items.map((member) => member.id));
			cursor = page.nextCursor ?? undefined;
		} while (cursor);
		expect(seen.sort()).toEqual([...added].sort());
	});

	it('changes a role inside its own organisation only', async () => {
		const orgId = await newOrganization();
		const member = await addMember(db, orgId, { userId: crypto.randomUUID(), role: 'viewer' });
		expect(await setMemberRole(db, orgId, member.id, 'admin')).toBe(true);
		expect((await getMember(db, orgId, member.userId))?.role).toBe('admin');
		expect(await setMemberRole(db, await newOrganization(), member.id, 'owner')).toBe(false);
	});
});

describe('invite repository', () => {
	it('stores only the token hash and leaves a pending invite once', async () => {
		const orgId = await newOrganization();
		const invite = await createInvite(db, orgId, {
			email: 'guest@example.test',
			role: 'billing',
			tokenHash: 'hash-of-token',
			invitedBy: 'user-1',
			expiresAt: Date.now() + 60_000
		});
		const read = await getInvite(db, orgId, invite.id);
		expect(read?.state).toBe('pending');
		expect(read).not.toHaveProperty('tokenHash');
		expect(await setInviteState(db, orgId, invite.id, 'accepted')).toBe(true);
		expect(await setInviteState(db, orgId, invite.id, 'revoked')).toBe(false);
		expect((await getInvite(db, orgId, invite.id))?.state).toBe('accepted');
	});
});

describe('api key repository', () => {
	it('finds a key by its hash, and revokes it once within its own organisation', async () => {
		const orgId = await newOrganization();
		const keyHash = `hash-${crypto.randomUUID()}`;
		const key = await createApiKey(db, orgId, {
			name: 'ci',
			keyHash,
			scopes: ['site.deploy', 'site.read'],
			createdBy: 'user-1',
			expiresAt: null
		});
		const found = await getApiKeyByHash(db, orgId, keyHash);
		expect(found).toEqual(key);
		expect(found?.scopes).toEqual(['site.deploy', 'site.read']);
		expect(await getApiKeyByHash(db, await newOrganization(), keyHash)).toBeNull();
		expect(await revokeApiKey(db, await newOrganization(), key.id)).toBe(false);
		expect(await revokeApiKey(db, orgId, key.id)).toBe(true);
		expect(await revokeApiKey(db, orgId, key.id)).toBe(false);
		expect((await getApiKeyByHash(db, orgId, keyHash))?.revokedAt).not.toBeNull();
	});
});

describe('delegation repository', () => {
	it('moves a delegation from pending to active to revoked, one step at a time', async () => {
		const clientOrgId = await newOrganization();
		const agencyOrgId = await newOrganization();
		const delegation = await createDelegation(db, clientOrgId, {
			agencyOrganizationId: agencyOrgId,
			role: 'maintainer',
			siteId: null,
			createdBy: 'user-1',
			expiresAt: null
		});
		expect((await getDelegation(db, clientOrgId, delegation.id))?.state).toBe('pending');
		expect(await acceptDelegation(db, clientOrgId, delegation.id, 'agency-user')).toBe(true);
		expect(await acceptDelegation(db, clientOrgId, delegation.id, 'agency-user')).toBe(false);
		expect(await revokeDelegation(db, clientOrgId, delegation.id)).toBe(true);
		expect(await revokeDelegation(db, clientOrgId, delegation.id)).toBe(false);
		const final = await getDelegation(db, clientOrgId, delegation.id);
		expect(final?.state).toBe('revoked');
		expect(final?.acceptedBy).toBe('agency-user');
	});
});

describe('site grant repository', () => {
	it('refuses a duplicate active grant and allows a new one after revoke', async () => {
		const orgId = await newOrganization();
		const siteId = crypto.randomUUID();
		const userId = crypto.randomUUID();
		const grant = await createSiteGrant(db, orgId, {
			siteId,
			userId,
			role: 'viewer',
			createdBy: 'user-1'
		});
		await expect(
			createSiteGrant(db, orgId, { siteId, userId, role: 'maintainer', createdBy: 'user-1' })
		).rejects.toBeInstanceOf(DuplicateRowError);
		expect(await getSiteGrant(db, orgId, grant.id)).toEqual(grant);
		expect(await revokeSiteGrant(db, orgId, grant.id)).toBe(true);
		expect(await revokeSiteGrant(db, orgId, grant.id)).toBe(false);
		expect((await getSiteGrant(db, orgId, grant.id))?.revokedAt).not.toBeNull();
		const again = await createSiteGrant(db, orgId, {
			siteId,
			userId,
			role: 'maintainer',
			createdBy: 'user-1'
		});
		expect(again.id).not.toBe(grant.id);
	});
});

describe('user organisation listing', () => {
	let shards: OpenBindings;
	let spread: CollegeDBClient;

	beforeAll(async () => {
		shards = await openBindings(TWO_SHARD_CONFIG);
		spread = await ensureCollegeDB(shards.env);
	});

	afterAll(() => shards.close());

	async function join(userId: string, name: string, personal: boolean, role: OrganizationRole) {
		const org = await createOrganization(spread, { name, personal, createdBy: userId });
		await addMember(spread, org.id, { userId, role });
		return org;
	}

	// organisation ids are random, so keep joining until the user's rows sit on both shards
	async function joinBothShards(userId: string): Promise<string[]> {
		const names: string[] = [];
		for (let i = 0; i < 64 && (await shardsHolding(userId)) < 2; i++) {
			const name = `org ${String(i).padStart(2, '0')}`;
			names.push((await join(userId, name, false, 'developer')).name);
		}
		expect(await shardsHolding(userId)).toBe(2);
		return names;
	}

	async function shardsHolding(userId: string): Promise<number> {
		const counts = await spread.allAllShards<{ n: number }>(
			'SELECT COUNT(*) AS n FROM members WHERE user_id = ?',
			[userId]
		);
		return counts.filter((shard) => (shard.results[0]?.n ?? 0) > 0).length;
	}

	it('lists the personal organisation first, then by name, with the role in each', async () => {
		const userId = crypto.randomUUID();
		const acme = await join(userId, 'Acme', false, 'admin');
		const personal = await join(userId, 'Zed personal', true, 'owner');
		const bolt = await join(userId, 'Bolt', false, 'viewer');
		const page = await listUserOrganizations(spread, userId, { limit: 10 });
		expect(page.items).toEqual([
			{ id: personal.id, name: 'Zed personal', personal: true, role: 'owner' },
			{ id: acme.id, name: 'Acme', personal: false, role: 'admin' },
			{ id: bolt.id, name: 'Bolt', personal: false, role: 'viewer' }
		]);
		expect(page.nextCursor).toBeNull();
	});

	it('never lists another person organisations, and an empty user gets an empty page', async () => {
		const userId = crypto.randomUUID();
		await join(userId, 'Mine', false, 'owner');
		await join(crypto.randomUUID(), 'Not mine', false, 'owner');
		const page = await listUserOrganizations(spread, userId, { limit: 10 });
		expect(page.items.map((org) => org.name)).toEqual(['Mine']);
		expect(await listUserOrganizations(spread, crypto.randomUUID(), { limit: 10 })).toEqual({
			items: [],
			nextCursor: null
		});
	});

	it('pages across both shards, each organisation once, in the same order', async () => {
		const userId = crypto.randomUUID();
		const names = await joinBothShards(userId);
		const seen: string[] = [];
		let after: OrganizationCursor | undefined;
		let pages = 0;
		let page;
		do {
			page = await listUserOrganizations(spread, userId, { after, limit: 1 });
			pages += 1;
			seen.push(...page.items.map((org) => org.name));
			const last = page.items.at(-1);
			if (last) after = { personal: last.personal, name: last.name, id: last.id };
		} while (page.nextCursor !== null);
		expect(seen).toEqual([...names].sort());
		expect(pages).toBe(names.length);
	});

	it('rejects with the typed error when one shard fails, and returns no partial list', async () => {
		const userId = crypto.randomUUID();
		await joinBothShards(userId);
		const failingFirst = new Proxy(spread, {
			get(target, property) {
				if (property !== 'allAllShards') return Reflect.get(target, property, target);
				return async (...args: Parameters<typeof target.allAllShards>) => {
					const shards = await target.allAllShards(...args);
					return shards.map((shard, index) =>
						index === 0 ? { ...shard, success: false } : shard
					);
				};
			}
		});
		await expect(
			listUserOrganizations(failingFirst, userId, { limit: 10 })
		).rejects.toBeInstanceOf(OrganizationListError);
	});
});
