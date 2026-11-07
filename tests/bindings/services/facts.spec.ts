import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { createApiKeyWithLookup } from '../../../src/server/db/repos/api-key-lookup';
import { listActiveDelegations } from '../../../src/server/db/repos/delegations';
import { listUserSiteGrants } from '../../../src/server/db/repos/grants';
import {
	acceptDelegation,
	addMember,
	createDelegation,
	createSiteGrant,
	revokeDelegation,
	revokeSiteGrant
} from '../../../src/server/db/repos/organization';
import { findSiteHome } from '../../../src/server/db/repos/site-lookup';
import { authorize, type Principal } from '../../../src/server/domain/authorize';
import { generateApiKey } from '../../../src/server/services/api-keys';
import { buildServices, type BootEnv } from '../../../src/server/services/boot';
import { collegeFactsStore, factsLoader, type FactsDeps } from '../../../src/server/services/facts';
import {
	collegeKeyIndex,
	resolveCredential,
	type AuthServices
} from '../../../src/server/utils/auth';
import type { LoadInput } from '../../../src/server/utils/define-api';
import { nowUtc, setClock } from '../../../src/shared/utils/time';
import { useClock } from '../../unit/server/services/auth-support';
import { openBindings, TWO_SHARD_CONFIG, type Bindings, type OpenBindings } from '../support';

const ORGS = {
	a: 'org_facta0001',
	b: 'org_factb0002',
	agency: 'org_facty0003',
	c: 'org_factc0004',
	d: 'org_factd0005',
	e: 'org_facte0006'
};
const SITES = {
	a1: 'site_facta00001',
	a2: 'site_facta00002',
	b1: 'site_factb00001',
	c1: 'site_factc00001',
	d1: 'site_factd00001',
	e1: 'site_facte00001'
};
const SITE_OWNER: Record<string, string> = {
	[SITES.a1]: ORGS.a,
	[SITES.a2]: ORGS.a,
	[SITES.b1]: ORGS.b,
	[SITES.c1]: ORGS.c,
	[SITES.d1]: ORGS.d,
	[SITES.e1]: ORGS.e
};
const ALICE = 'user-alice';
const BOB = 'user-bob';
const CAROL = 'user-carol';
const AGENT = 'user-agent';

const user = (userId: string): Principal => ({ kind: 'user', userId });
const orgInput = (orgId: string, principal: Principal): LoadInput => ({
	principal,
	scope: 'organization',
	action: 'org.read',
	params: { orgId }
});
const siteInput = (id: string, principal: Principal, extra: Record<string, string> = {}) =>
	({ principal, scope: 'site', action: 'site.read', params: { id, ...extra } }) as LoadInput;

async function suite(config: string | undefined, label: string) {
	describe(`facts loader over local D1 (${label})`, () => {
		let open: OpenBindings;
		let env: Bindings;
		let db: CollegeDBClient;
		let deps: FactsDeps;
		const load = (input: LoadInput) => factsLoader(deps)(input);

		const decide = async (input: LoadInput) => {
			const loaded = await load(input);
			if (!loaded) return null;
			return authorize({
				principal: input.principal,
				action: input.action,
				resource: loaded.resource,
				facts: loaded.facts
			});
		};

		beforeAll(async () => {
			open = await openBindings(config);
			env = open.env;
			db = await ensureCollegeDB(env);
			deps = { store: collegeFactsStore(async () => db) };
			const now = Date.now();
			for (const id of Object.values(ORGS)) {
				await db.run(
					id,
					`INSERT INTO organizations (id, name, personal, created_by, created_at, updated_at)
					 VALUES (?, ?, 0, ?, ?, ?)`,
					[id, id, ALICE, now, now]
				);
			}
			for (const [id, orgId] of Object.entries(SITE_OWNER)) {
				await db.run(
					orgId,
					`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
					 VALUES (?, ?, ?, 'managed', 'active', ?, ?)`,
					[id, orgId, id, now, now]
				);
			}
			await addMember(db, ORGS.a, { userId: ALICE, role: 'viewer' });
			await addMember(db, ORGS.a, { userId: CAROL, role: 'developer' });
			await addMember(db, ORGS.b, { userId: BOB, role: 'owner' });
			await addMember(db, ORGS.agency, { userId: AGENT, role: 'admin' });
		});

		afterAll(() => open.close());
		afterEach(() => setClock(null));

		it('gives a viewer of the organisation viewer facts that authorize reads', async () => {
			const loaded = await load(orgInput(ORGS.a, user(ALICE)));
			expect(loaded?.resource).toEqual({ orgId: ORGS.a });
			expect(loaded?.facts.membership).toEqual({ orgId: ORGS.a, role: 'viewer' });
			expect(await decide(orgInput(ORGS.a, user(ALICE)))).toMatchObject({
				allow: true,
				via: 'organisation'
			});
			expect(
				await decide({ ...orgInput(ORGS.a, user(ALICE)), action: 'member.invite' })
			).toMatchObject({ allow: false, reason: 'forbidden' });
		});

		it('answers null for another organisation, an unknown one and a blank one', async () => {
			expect(await load(orgInput(ORGS.b, user(ALICE)))).toBeNull();
			expect(await load(orgInput('org_nothere0009', user(ALICE)))).toBeNull();
			expect(await load(orgInput('  ', user(ALICE)))).toBeNull();
		});

		it('looks a padded, upper case path value up as its normal form and returns the row id', async () => {
			const loaded = await load(orgInput(`  ${ORGS.a.toUpperCase()} `, user(ALICE)));
			expect(loaded?.resource.orgId).toBe(ORGS.a);
			const site = await load(siteInput(` ${SITES.a1.toUpperCase()}`, user(CAROL)));
			expect(site?.resource).toEqual({ orgId: ORGS.a, siteId: SITES.a1 });
		});

		it('takes the site organisation from the row, so a site of another organisation is not found', async () => {
			expect(await load(siteInput(SITES.b1, user(ALICE)))).toBeNull();
			expect(await load(siteInput(SITES.b1, user(ALICE), { orgId: ORGS.a }))).toBeNull();
			expect(await load(siteInput(SITES.b1, user(BOB), { orgId: ORGS.a }))).toBeNull();
			expect(await decide(siteInput(SITES.b1, user(BOB)))).toMatchObject({
				allow: true,
				via: 'organisation'
			});
		});

		it('lets a site grant reach its site only, and stops at revoke', async () => {
			const grant = await createSiteGrant(db, ORGS.c, {
				siteId: SITES.c1,
				userId: BOB,
				role: 'viewer',
				createdBy: ALICE
			});
			expect(await listUserSiteGrants(db, ORGS.c, BOB)).toEqual([
				{ level: 'site', orgId: ORGS.c, targetId: SITES.c1, role: 'viewer' }
			]);
			expect(await decide(siteInput(SITES.c1, user(BOB)))).toMatchObject({
				allow: true,
				via: 'site'
			});
			expect(await revokeSiteGrant(db, ORGS.c, grant.id)).toBe(true);
			expect(await load(siteInput(SITES.c1, user(BOB)))).toBeNull();
		});

		it('ignores a grant stored under another organisation that names this site', async () => {
			await createSiteGrant(db, ORGS.a, {
				siteId: SITES.e1,
				userId: ALICE,
				role: 'site-admin',
				createdBy: CAROL
			});
			expect(await load(siteInput(SITES.e1, user(ALICE)))).toBeNull();
		});

		describe('delegation', () => {
			const delegate = async (
				clientOrgId: string,
				over: { expiresAt?: number | null; accept?: boolean; revoke?: boolean } = {}
			) => {
				const created = await createDelegation(db, clientOrgId, {
					agencyOrganizationId: ORGS.agency,
					role: 'maintainer',
					siteId: null,
					createdBy: ALICE,
					expiresAt: over.expiresAt ?? null
				});
				if (over.accept !== false)
					await acceptDelegation(db, clientOrgId, created.id, AGENT);
				if (over.revoke) await revokeDelegation(db, clientOrgId, created.id);
				return created;
			};

			it('reaches the client site through an accepted delegation, audited in both organisations', async () => {
				await delegate(ORGS.d);
				const decision = await decide({
					...siteInput(SITES.d1, user(AGENT)),
					action: 'site.read'
				});
				expect(decision).toMatchObject({
					allow: true,
					via: 'delegation',
					audit: [ORGS.d, ORGS.agency]
				});
			});

			it.each([
				['revoked', { revoke: true }],
				['expired', { expiresAt: Date.now() - 60_000 }],
				['not yet accepted', { accept: false }]
			])('gives no access through a %s delegation', async (_name, over) => {
				const client = ORGS.e;
				const before = await listActiveDelegations(db, client);
				await delegate(client, over);
				// the repository never reads a revoked or pending row; the loader drops the expired one
				const active = (await listActiveDelegations(db, client)).length - before.length;
				expect(active).toBe(over.expiresAt === undefined ? 0 : 1);
				expect(await load(siteInput(SITES.e1, user(AGENT)))).toBeNull();
				expect(await load(orgInput(client, user(AGENT)))).toBeNull();
			});

			it('yields org_suspended when the agency is suspended', async () => {
				const suspended: FactsDeps = {
					...deps,
					suspensions: async () => ({ orgIds: [ORGS.agency], user: false })
				};
				const loaded = await factsLoader(suspended)(siteInput(SITES.d1, user(AGENT)));
				expect(
					authorize({
						principal: user(AGENT),
						action: 'site.read',
						resource: loaded!.resource,
						facts: loaded!.facts
					})
				).toEqual({ allow: false, reason: 'org_suspended' });
			});

			it('gives no access to a delegation of another client or to a person outside the agency', async () => {
				expect(await load(siteInput(SITES.b1, user(AGENT)))).toBeNull();
				expect(await load(siteInput(SITES.d1, user(ALICE)))).toBeNull();
			});
		});

		describe('api key', () => {
			const issue = async (over: { revokedAt?: number; expiresAt?: number } = {}) => {
				const generated = await generateApiKey({
					scopes: ['site.read'],
					expiry: '30d',
					now: nowUtc().toMillis()
				});
				const created = await createApiKeyWithLookup(db, ORGS.a, {
					lookupId: generated.data.lookupId,
					name: 'facts test',
					keyHash: generated.data.keyHash,
					scopes: ['site.read'],
					createdBy: CAROL,
					expiresAt: over.expiresAt ?? generated.data.expiresAt
				});
				if (over.revokedAt !== undefined) {
					await db.run(ORGS.a, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [
						over.revokedAt,
						created.id
					]);
				}
				const principal = await resolveCredential(
					{ keys: collegeKeyIndex(async () => db) } as unknown as AuthServices,
					{ kind: 'bearer', token: generated.token }
				);
				expect(principal?.kind).toBe('key');
				return principal as Principal;
			};

			it('gets the issuer facts and the key record, and is stopped by the key scope', async () => {
				useClock();
				const principal = await issue();
				const loaded = await load(siteInput(SITES.a1, principal));
				expect(loaded?.facts.membership).toEqual({ orgId: ORGS.a, role: 'developer' });
				expect(loaded?.facts.key?.scopes).toEqual(['site.read']);
				expect(await decide(siteInput(SITES.a1, principal))).toMatchObject({ allow: true });
				expect(
					await decide({ ...siteInput(SITES.a1, principal), action: 'site.deploy' })
				).toEqual({
					allow: false,
					reason: 'key_scope'
				});
				expect(await load(siteInput(SITES.b1, principal))).toBeNull();
			});

			it('gets null once the key is revoked after it resolved', async () => {
				const c = useClock();
				const principal = await issue({ revokedAt: c.now + 500 });
				expect(await load(siteInput(SITES.a1, principal))).not.toBeNull();
				c.advance(500);
				expect(await load(siteInput(SITES.a1, principal))).toBeNull();
			});

			it('stops resolving at all once the key row is revoked', async () => {
				useClock();
				const generated = await generateApiKey({
					scopes: ['site.read'],
					expiry: '30d',
					now: nowUtc().toMillis()
				});
				await createApiKeyWithLookup(db, ORGS.a, {
					lookupId: generated.data.lookupId,
					name: 'revoked first',
					keyHash: generated.data.keyHash,
					scopes: ['site.read'],
					createdBy: CAROL,
					expiresAt: generated.data.expiresAt
				});
				await db.run(ORGS.a, 'UPDATE api_keys SET revoked_at = 1 WHERE key_hash = ?', [
					generated.data.keyHash
				]);
				expect(
					await resolveCredential(
						{ keys: collegeKeyIndex(async () => db) } as unknown as AuthServices,
						{ kind: 'bearer', token: generated.token }
					)
				).toBeNull();
			});
		});

		it('refuses a scope it has no facts for', async () => {
			await expect(
				load({ ...orgInput(ORGS.a, user(ALICE)), scope: 'public' })
			).rejects.toMatchObject({ code: 'not_built' });
		});
	});
}

await suite(undefined, 'one shard');
await suite(TWO_SHARD_CONFIG, 'two shards');

describe('site lookup over local D1 shards', () => {
	let open: OpenBindings;
	let db: CollegeDBClient;

	beforeAll(async () => {
		open = await openBindings(TWO_SHARD_CONFIG);
		db = await ensureCollegeDB(open.env);
		const now = Date.now();
		for (let i = 0; i < 12; i++) {
			const orgId = `org_spread${String(i).padStart(4, '0')}`;
			await db.run(
				orgId,
				`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
				 VALUES (?, ?, ?, 'managed', 'active', ?, ?)`,
				[`site_spread${String(i).padStart(4, '0')}`, orgId, `s${i}`, now, now]
			);
		}
	});

	afterAll(() => open.close());

	it('finds a site on whichever shard holds it', async () => {
		const counts = await db.allAllShards<{ c: number }>('SELECT COUNT(*) AS c FROM sites');
		expect(counts.length).toBe(2);
		for (const shard of counts) expect(shard.results[0]?.c).toBeGreaterThan(0);
		for (let i = 0; i < 12; i++) {
			const n = String(i).padStart(4, '0');
			expect(await findSiteHome(db, `site_spread${n}`)).toEqual({
				id: `site_spread${n}`,
				organizationId: `org_spread${n}`
			});
		}
		expect(await findSiteHome(db, 'site_spread9999')).toBeNull();
	});

	it('finds nothing for an id that two shards both hold, so neither owner is chosen', async () => {
		const now = Date.now();
		const shards = await db.listKnownShards();
		expect(shards.length).toBe(2);
		for (const [index, shard] of shards.entries()) {
			await db.runShard(
				shard,
				`INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
				 VALUES ('site_twice0001', ?, 'twice', 'managed', 'active', ?, ?)`,
				[`org_twice000${index}`, now, now]
			);
		}
		expect(await findSiteHome(db, 'site_twice0001')).toBeNull();
	});
});

describe('boot wiring', () => {
	let open: OpenBindings;

	beforeAll(async () => {
		open = await openBindings();
		const db = await ensureCollegeDB(open.env);
		const now = Date.now();
		await db.run(
			'org_boot00001',
			`INSERT INTO organizations (id, name, personal, created_by, created_at, updated_at)
			 VALUES ('org_boot00001', 'boot', 0, 'u', ?, ?)`,
			[now, now]
		);
		await addMember(db, 'org_boot00001', { userId: 'user-boot', role: 'owner' });
	});

	afterAll(() => open.close());

	it('builds a loader that answers organisation scope from D1 and takes ports from the options', async () => {
		const asked: string[] = [];
		const built = buildServices(open.env as BootEnv, {
			facts: { entitlements: async (orgId) => (asked.push(orgId), ['pilots']) }
		});
		const loaded = await built.api.load!({
			principal: user('user-boot'),
			scope: 'organization',
			action: 'org.read',
			params: { orgId: 'org_boot00001' }
		});
		expect(loaded?.facts.membership).toEqual({ orgId: 'org_boot00001', role: 'owner' });
		expect(loaded?.facts.entitlements).toEqual(['pilots']);
		expect(asked).toEqual(['org_boot00001']);
		expect(
			await built.api.load!({
				principal: user('user-stranger'),
				scope: 'organization',
				action: 'org.read',
				params: { orgId: 'org_boot00001' }
			})
		).toBeNull();
	});
});
