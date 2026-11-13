import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { orgId } from '../../../contracts/src/common';
import { DuplicateRowError, ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	ensurePersonalOrganization,
	getPersonalOrganizationId,
	personalOrganizationId
} from '../../../src/server/db/repos/accounts';
import {
	createApiKeyWithLookup,
	findApiKeyByLookup
} from '../../../src/server/db/repos/api-key-lookup';
import { createUser } from '../../../src/server/db/repos/identity';
import type { PasskeyRecord } from '../../../src/server/integrations/webauthn';
import { collegeIdentityStore, type IdentityStore } from '../../../src/server/services/identities';
import { collegeKeyIndex } from '../../../src/server/utils/auth';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let open: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;
let store: IdentityStore;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	db = await ensureCollegeDB(env);
	store = collegeIdentityStore(async () => db);
});

afterAll(() => open.close());

const email = () => `person-${crypto.randomUUID()}@example.test`;

const passkey = (userId: string, over: Partial<PasskeyRecord> = {}): PasskeyRecord => ({
	id: `cred-${crypto.randomUUID()}`,
	userId,
	publicKey: 'cHVibGljLWtleQ',
	counter: 0,
	transports: ['internal', 'hybrid'],
	deviceType: 'multiDevice',
	backedUp: true,
	name: 'Laptop',
	createdAt: 1000,
	lastUsedAt: null,
	...over
});

describe('personal organisation', () => {
	it('is made with its owner membership in one step and found by the user id alone', async () => {
		const user = await createUser(db, { email: email() });
		expect(await getPersonalOrganizationId(db, user.id)).toBeNull();
		const first = await ensurePersonalOrganization(db, user.id);
		expect(first.created).toBe(true);
		expect(first.org).toMatchObject({
			id: personalOrganizationId(user.id),
			personal: true,
			createdBy: user.id
		});
		expect(await getPersonalOrganizationId(db, user.id)).toBe(first.org.id);
		expect(await store.personalOrganizationId(user.id)).toBe(first.org.id);
	});

	it('has an id the organisation contract accepts, and a different id for each user', async () => {
		const one = await createUser(db, { email: email() });
		const two = await createUser(db, { email: email() });
		expect(orgId.safeParse(personalOrganizationId(one.id)).success).toBe(true);
		expect(personalOrganizationId(one.id)).not.toBe(personalOrganizationId(two.id));
	});

	it('changes nothing the second time', async () => {
		const user = await createUser(db, { email: email() });
		await ensurePersonalOrganization(db, user.id);
		const again = await ensurePersonalOrganization(db, user.id);
		expect(again.created).toBe(false);
		const members = await env.DB.prepare('SELECT count(*) AS n FROM members WHERE user_id = ?')
			.bind(user.id)
			.first<{ n: number }>();
		expect(members?.n).toBe(1);
	});

	it('leaves one organisation and one membership when five sign-ins heal together, and one reports it', async () => {
		const user = await createUser(db, { email: email() });
		const results = await Promise.all(
			Array.from({ length: 5 }, () => ensurePersonalOrganization(db, user.id))
		);
		expect(results.filter((result) => result.created)).toHaveLength(1);
		const orgs = await env.DB.prepare(
			'SELECT count(*) AS n FROM organizations WHERE created_by = ?'
		)
			.bind(user.id)
			.first<{ n: number }>();
		const members = await env.DB.prepare('SELECT count(*) AS n FROM members WHERE user_id = ?')
			.bind(user.id)
			.first<{ n: number }>();
		expect([orgs?.n, members?.n]).toEqual([1, 1]);
	});

	it('adds the missing membership to an organisation that has none', async () => {
		const user = await createUser(db, { email: email() });
		const id = personalOrganizationId(user.id);
		await env.DB.prepare(
			`INSERT INTO organizations (id, name, personal, created_by, created_at, updated_at)
			 VALUES (?, 'Personal', 1, ?, 1, 1)`
		)
			.bind(id, user.id)
			.run();
		expect(await getPersonalOrganizationId(db, user.id)).toBeNull();
		await ensurePersonalOrganization(db, user.id);
		expect(await getPersonalOrganizationId(db, user.id)).toBe(id);
	});
});

describe('identities on D1', () => {
	it('lists a user identities in creation order and no one else', async () => {
		const owner = await createUser(db, { email: email() });
		const other = await createUser(db, { email: email() });
		const github = await store.createIdentity({
			userId: owner.id,
			provider: 'github',
			providerSubject: crypto.randomUUID(),
			email: owner.email,
			verified: true
		});
		await store.createIdentity({
			userId: other.id,
			provider: 'github',
			providerSubject: crypto.randomUUID(),
			email: other.email,
			verified: true
		});
		expect((await store.listIdentities(owner.id)).map((i) => i.id)).toEqual([github.id]);
		expect(await store.findIdentity('github', github.providerSubject)).toMatchObject({
			id: github.id
		});
	});

	it('refuses a second identity for one provider subject', async () => {
		const user = await createUser(db, { email: email() });
		const subject = crypto.randomUUID();
		const input = {
			userId: user.id,
			provider: 'google',
			providerSubject: subject,
			email: user.email,
			verified: true
		};
		await store.createIdentity(input);
		await expect(store.createIdentity(input)).rejects.toBeInstanceOf(DuplicateRowError);
	});

	it('deletes an identity only for its owner', async () => {
		const owner = await createUser(db, { email: email() });
		const other = await createUser(db, { email: email() });
		const identity = await store.createIdentity({
			userId: owner.id,
			provider: 'gitlab',
			providerSubject: crypto.randomUUID(),
			email: owner.email,
			verified: true
		});
		expect(await store.deleteIdentity(other.id, identity.id)).toBe(false);
		expect(await store.deleteIdentity(owner.id, identity.id)).toBe(true);
		expect(await store.deleteIdentity(owner.id, identity.id)).toBe(false);
		expect(await store.listIdentities(owner.id)).toEqual([]);
	});
});

describe('passkeys on D1', () => {
	it('stores a passkey and reads it back whole, by id and by user', async () => {
		const user = await createUser(db, { email: email() });
		const record = passkey(user.id);
		await store.insertPasskey(record);
		expect(await store.getPasskey(record.id)).toEqual(record);
		expect(await store.listPasskeys(user.id)).toEqual([record]);
		expect(await store.getPasskey('missing')).toBeNull();
	});

	it('refuses the same credential id twice', async () => {
		const user = await createUser(db, { email: email() });
		const record = passkey(user.id);
		await store.insertPasskey(record);
		await expect(store.insertPasskey(record)).rejects.toBeInstanceOf(DuplicateRowError);
	});

	it('refuses a device type outside the two it knows', async () => {
		const user = await createUser(db, { email: email() });
		await expect(
			store.insertPasskey(passkey(user.id, { deviceType: 'other' as never }))
		).rejects.toThrow();
	});

	it('advances the counter only from the value the caller verified, so one replay wins', async () => {
		const user = await createUser(db, { email: email() });
		const record = passkey(user.id, { counter: 4 });
		await store.insertPasskey(record);
		const results = await Promise.all(
			Array.from({ length: 6 }, () => store.advancePasskeyCounter(record.id, 4, 5, 2000))
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await store.getPasskey(record.id)).toMatchObject({ counter: 5, lastUsedAt: 2000 });
		expect(await store.advancePasskeyCounter(record.id, 4, 9, 3000)).toBe(false);
	});

	it('renames and removes a passkey only for its owner', async () => {
		const owner = await createUser(db, { email: email() });
		const other = await createUser(db, { email: email() });
		const record = passkey(owner.id);
		await store.insertPasskey(record);
		expect(await store.renamePasskey(other.id, record.id, 'Stolen')).toBe(false);
		expect(await store.renamePasskey(owner.id, record.id, 'Phone')).toBe(true);
		expect((await store.getPasskey(record.id))?.name).toBe('Phone');
		expect(await store.deletePasskey(other.id, record.id)).toBe(false);
		expect(await store.deletePasskey(owner.id, record.id)).toBe(true);
		expect(await store.listPasskeys(owner.id)).toEqual([]);
	});
});

describe('API key lookup on D1', () => {
	const lookupId = () => crypto.randomUUID().replaceAll('-', '').slice(0, 12);

	async function newKey(over: { lookupId?: string; expiresAt?: number | null } = {}) {
		const user = await createUser(db, { email: email() });
		const orgId = personalOrganizationId(user.id);
		await ensurePersonalOrganization(db, user.id);
		const lookup = over.lookupId ?? lookupId();
		const key = await createApiKeyWithLookup(db, orgId, {
			lookupId: lookup,
			name: 'ci',
			keyHash: `hash-${crypto.randomUUID()}`,
			scopes: ['site.read', 'member.read'],
			createdBy: user.id,
			expiresAt: over.expiresAt === undefined ? 5000 : over.expiresAt
		});
		return { user, orgId, lookup, key };
	}

	it('finds a key from its lookup id with two keyed reads and no scan', async () => {
		const { user, orgId, lookup, key } = await newKey();
		expect(await findApiKeyByLookup(db, lookup)).toEqual({
			keyId: key.id,
			issuerId: user.id,
			orgId,
			keyHash: expect.stringMatching(/^hash-/),
			scopes: ['site.read', 'member.read'],
			expiresAt: 5000,
			revokedAt: null,
			lastUsedAt: null
		});
		expect(await findApiKeyByLookup(db, lookupId())).toBeNull();
	});

	it('reads revocation from the key row, so there is no second copy to go stale', async () => {
		const { orgId, lookup, key } = await newKey();
		await env.DB.prepare(
			'UPDATE api_keys SET revoked_at = 77 WHERE organization_id = ? AND id = ?'
		)
			.bind(orgId, key.id)
			.run();
		expect((await findApiKeyByLookup(db, lookup))?.revokedAt).toBe(77);
	});

	it('hands the resolver a record without nulls through the production index', async () => {
		const { lookup, key } = await newKey({ expiresAt: null });
		const found = await collegeKeyIndex(async () => db).find(lookup);
		expect(found).toMatchObject({ keyId: key.id, scopes: ['site.read', 'member.read'] });
		expect(found).not.toHaveProperty('expiresAt');
		expect(found).not.toHaveProperty('revokedAt');
	});

	it('refuses a second key under one lookup id', async () => {
		const first = await newKey();
		await expect(newKey({ lookupId: first.lookup })).rejects.toBeInstanceOf(DuplicateRowError);
	});

	it('leaves a key with no lookup row unresolvable', async () => {
		const { lookup } = await newKey();
		await env.DB.prepare('DELETE FROM api_key_lookup WHERE lookup_id = ?').bind(lookup).run();
		expect(await findApiKeyByLookup(db, lookup)).toBeNull();
	});
});
