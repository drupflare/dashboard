import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSiteHome, SiteLookupError } from '../../../../src/server/db/repos/site-lookup';
import {
	authorize,
	type Membership,
	type Principal
} from '../../../../src/server/domain/authorize';
import type { Delegation } from '../../../../src/server/domain/delegation';
import type { Grant } from '../../../../src/server/domain/policy';
import { generateApiKey } from '../../../../src/server/services/api-keys';
import {
	loadFacts,
	lookupKey,
	type FactsDeps,
	type FactsStore
} from '../../../../src/server/services/facts';
import { resolveCredential, type AuthServices } from '../../../../src/server/utils/auth';
import type { LoadInput } from '../../../../src/server/utils/define-api';
import type { OrgRole } from '../../../../src/shared/permissions';
import { T0, useClock } from './auth-support';

const A = 'org_alpha0001';
const B = 'org_bravo0002';
const AGENCY = 'org_agency0003';
const SITE_A = 'site_alpha0001';
const SITE_A2 = 'site_alpha0002';
const SITE_B = 'site_bravo0001';
const ME = 'user-me';
const OTHER = 'user-other';

interface Data {
	orgs: string[];
	sites: { id: string; orgId: string }[];
	members: (Membership & { userId: string })[];
	grants: (Grant & { userId: string })[];
	delegations: Delegation[];
}

const data = (over: Partial<Data> = {}): Data => ({
	orgs: [A, B, AGENCY],
	sites: [
		{ id: SITE_A, orgId: A },
		{ id: SITE_A2, orgId: A },
		{ id: SITE_B, orgId: B }
	],
	members: [],
	grants: [],
	delegations: [],
	...over
});

// a store over plain rows that records every call; fuzzy mimics a lookup that ignores case and
// surrounding space, the kind of store a collation or a LIKE would produce
function makeStore(rows: Data, fuzzy = false) {
	const calls: { method: string; args: string[] }[] = [];
	const same = (a: string, b: string) =>
		fuzzy ? a.trim().toLowerCase() === b.trim().toLowerCase() : a === b;
	const store: FactsStore = {
		async organization(id) {
			calls.push({ method: 'organization', args: [id] });
			const row = rows.orgs.find((org) => same(org, id));
			return row ? { id: row } : null;
		},
		async site(id) {
			calls.push({ method: 'site', args: [id] });
			return rows.sites.find((site) => same(site.id, id)) ?? null;
		},
		async member(orgId, userId) {
			calls.push({ method: 'member', args: [orgId, userId] });
			const row = rows.members.find((m) => same(m.orgId, orgId) && m.userId === userId);
			return row ? { orgId: row.orgId, role: row.role } : null;
		},
		async siteGrants(orgId, userId) {
			calls.push({ method: 'siteGrants', args: [orgId, userId] });
			return rows.grants.filter((g) => same(g.orgId, orgId) && g.userId === userId);
		},
		async delegations(clientOrgId) {
			calls.push({ method: 'delegations', args: [clientOrgId] });
			return rows.delegations.filter((d) => same(d.clientOrgId, clientOrgId));
		}
	};
	return { store, calls };
}

const user = (userId = ME): Principal => ({ kind: 'user', userId });
const member = (orgId: string, role: OrgRole, userId = ME) => ({ orgId, role, userId });
const siteGrant = (siteId: string, role: Grant['role'], orgId = A, userId = ME) =>
	({ level: 'site', orgId, targetId: siteId, role, userId }) as Grant & { userId: string };

const delegation = (over: Partial<Delegation> = {}): Delegation => ({
	id: 'del-1',
	clientOrgId: A,
	agencyOrgId: AGENCY,
	role: 'maintainer',
	sites: 'all',
	status: 'active',
	createdBy: OTHER,
	createdAt: T0 - 10_000,
	...over
});

const orgInput = (orgId: string | undefined, principal = user()): LoadInput => ({
	principal,
	scope: 'organization',
	action: 'org.read',
	params: orgId === undefined ? {} : { orgId }
});

const siteInput = (
	id: string,
	principal = user(),
	extra: Record<string, string> = {}
): LoadInput => ({
	principal,
	scope: 'site',
	action: 'site.read',
	params: { id, ...extra }
});

let clock: ReturnType<typeof useClock>;

beforeEach(() => {
	clock = useClock(T0);
});
afterEach(() => clock.stop());

describe('lookupKey', () => {
	it('trims and lower-cases a path value and turns anything else into an empty key', () => {
		expect(lookupKey('  ORG_Alpha0001 ')).toBe('org_alpha0001');
		expect(lookupKey(undefined)).toBe('');
		expect(lookupKey(42)).toBe('');
	});
});

describe('organization scope', () => {
	it('gives a viewer of the organisation viewer facts that the real authorize reads', async () => {
		const { store } = makeStore(data({ members: [member(A, 'viewer')] }));
		const loaded = await loadFacts({ store }, orgInput(A));
		expect(loaded?.resource).toEqual({ orgId: A });
		expect(loaded?.facts.membership).toEqual({ orgId: A, role: 'viewer' });
		const { facts, resource } = loaded!;
		const decide = (action: string) =>
			authorize({ principal: user(), action, resource, facts });
		expect(decide('org.read')).toMatchObject({ allow: true, via: 'organisation' });
		expect(decide('member.invite')).toMatchObject({ allow: false, reason: 'forbidden' });
	});

	it('answers null for another organisation, reads no more than the caller own rows and none of the ports', async () => {
		const ports = {
			entitlements: vi.fn(async () => ['x']),
			budgets: vi.fn(async () => []),
			policy: vi.fn(async () => []),
			suspensions: vi.fn(async () => ({ orgIds: [], user: false })),
			support: vi.fn(async () => null)
		};
		const { store, calls } = makeStore(
			data({ members: [member(A, 'owner'), member(B, 'owner', OTHER)] })
		);
		expect(await loadFacts({ store, ...ports }, orgInput(B))).toBeNull();
		for (const call of calls.filter(
			(c) => c.method === 'member' || c.method === 'siteGrants'
		)) {
			expect(call.args).toEqual([B, ME]);
		}
		expect(calls.map((c) => c.method).sort()).toEqual([
			'delegations',
			'member',
			'organization',
			'siteGrants'
		]);
		expect(ports.entitlements).not.toHaveBeenCalled();
		expect(ports.budgets).not.toHaveBeenCalled();
		expect(ports.policy).not.toHaveBeenCalled();
		expect(ports.suspensions).not.toHaveBeenCalled();
	});

	it('answers an organisation that exists and one that does not with the same null', async () => {
		const { store } = makeStore(data({ members: [member(A, 'owner')] }));
		const real = await loadFacts({ store }, orgInput(B));
		const missing = await loadFacts({ store }, orgInput('org_nothere0009'));
		expect(real).toBeNull();
		expect(missing).toEqual(real);
	});

	it('finds nothing for a missing, empty or blank organisation parameter, and asks the store nothing', async () => {
		const { store, calls } = makeStore(data({ members: [member(A, 'owner')] }));
		for (const value of [undefined, '', '   ']) {
			expect(await loadFacts({ store }, orgInput(value))).toBeNull();
		}
		expect(calls).toEqual([]);
	});

	it('looks up the trimmed lower case key and puts the row id on the resource, not the request text', async () => {
		const legacy = 'ORG_Legacy0004';
		const { store, calls } = makeStore(
			data({ orgs: [legacy], members: [member(legacy, 'owner')] }),
			true
		);
		const loaded = await loadFacts({ store }, orgInput('  org_LEGACY0004 '));
		expect(calls[0]).toEqual({ method: 'organization', args: ['org_legacy0004'] });
		expect(loaded?.resource.orgId).toBe(legacy);
		expect(loaded?.resource.orgId).not.toBe('  org_LEGACY0004 ');
		expect(loaded?.facts.membership?.orgId).toBe(legacy);
	});

	it('reads the organisation id for every port from the row', async () => {
		const seen: string[] = [];
		const { store } = makeStore(data({ members: [member(A, 'owner')] }), true);
		const loaded = await loadFacts(
			{
				store,
				entitlements: async (orgId) => (seen.push(orgId), ['pilots']),
				budgets: async (orgId) => (seen.push(orgId), ['production-deploys']),
				policy: async ({ orgId }) => (seen.push(orgId), [])
			},
			orgInput(` ${A.toUpperCase()} `)
		);
		expect(new Set(seen)).toEqual(new Set([A]));
		expect(loaded?.facts.entitlements).toEqual(['pilots']);
		expect(loaded?.facts.budgetExceeded).toEqual(['production-deploys']);
	});

	it('carries the session step-up time and no key facts for a user', async () => {
		const { store } = makeStore(data({ members: [member(A, 'owner')] }));
		const loaded = await loadFacts(
			{ store },
			orgInput(A, { kind: 'user', userId: ME, stepUpAt: T0 - 5 } as Principal)
		);
		expect(loaded?.facts.stepUpAt).toBe(T0 - 5);
		expect(loaded?.facts.key).toBeUndefined();
	});

	it('gives the platform scope the standing the platform port reports, and none without it', async () => {
		const { store } = makeStore(data());
		const input = { ...orgInput(A), scope: 'admin' as const };
		expect((await loadFacts({ store }, input))?.facts.platform).toBeUndefined();
		const standing = { admin: true, access: true, permissions: ['read'] as const };
		const withRole = await loadFacts(
			{
				store,
				platform: async ({ userId, access }) => {
					expect(userId).toBe(ME);
					expect(access).toEqual({ email: 'a@example.test' });
					return standing;
				}
			},
			{ ...input, access: { email: 'a@example.test' } }
		);
		expect(withRole?.facts.platform).toEqual(standing);
	});

	it('refuses a key on the platform scope', async () => {
		const { store } = makeStore(data());
		const key = { kind: 'key' as const, keyId: 'k', issuerId: ME };
		expect(
			await loadFacts({ store }, { ...orgInput(A), principal: key, scope: 'admin' })
		).toBeNull();
	});
});

describe('site scope', () => {
	it('takes the organisation from the site row and the site id from the row', async () => {
		const { store } = makeStore(data({ members: [member(A, 'developer')] }));
		const loaded = await loadFacts({ store }, siteInput(SITE_A));
		expect(loaded?.resource).toEqual({ orgId: A, siteId: SITE_A });
		const decision = authorize({
			principal: user(),
			action: 'site.read',
			resource: loaded!.resource,
			facts: loaded!.facts
		});
		expect(decision).toMatchObject({ allow: true, via: 'organisation' });
	});

	it('answers null for a site of another organisation even when the caller belongs to the one in the path', async () => {
		const { store, calls } = makeStore(data({ members: [member(A, 'owner')] }));
		expect(await loadFacts({ store }, siteInput(SITE_B, user(), { orgId: A }))).toBeNull();
		expect(await loadFacts({ store }, siteInput(SITE_B))).toBeNull();
		// the facts for the site's own organisation were read for the caller only
		for (const call of calls.filter((c) => c.method === 'member')) {
			expect(call.args).toEqual([B, ME]);
		}
	});

	it('refuses a path organisation that differs from the site row even for a member of both', async () => {
		const { store } = makeStore(data({ members: [member(A, 'owner'), member(B, 'owner')] }));
		expect(await loadFacts({ store }, siteInput(SITE_B, user(), { orgId: A }))).toBeNull();
		expect(
			await loadFacts({ store }, siteInput(SITE_B, user(), { orgId: ` ${B.toUpperCase()}` }))
		).toMatchObject({ resource: { orgId: B, siteId: SITE_B } });
	});

	it('finds nothing for an unknown site, a blank id and a site whose organisation row is gone', async () => {
		const { store } = makeStore(data({ orgs: [B], members: [member(A, 'owner')] }));
		expect(await loadFacts({ store }, siteInput('site_nothere0009'))).toBeNull();
		expect(await loadFacts({ store }, siteInput('  '))).toBeNull();
		expect(await loadFacts({ store }, siteInput(SITE_A))).toBeNull();
	});

	it('lets a site grant reach its own site and forbids a sibling site of the same organisation', async () => {
		const { store } = makeStore(data({ grants: [siteGrant(SITE_A, 'viewer')] }));
		const own = await loadFacts({ store }, siteInput(SITE_A));
		const sibling = await loadFacts({ store }, siteInput(SITE_A2));
		const decide = (loaded: typeof own) =>
			authorize({
				principal: user(),
				action: 'site.read',
				resource: loaded!.resource,
				facts: loaded!.facts
			});
		expect(decide(own)).toMatchObject({ allow: true, via: 'site' });
		expect(decide(sibling)).toMatchObject({ allow: false, reason: 'forbidden' });
	});

	it('ignores a grant stored under another organisation that names this site', async () => {
		const { store } = makeStore(
			data({ grants: [siteGrant(SITE_B, 'maintainer', A)], members: [member(A, 'owner')] })
		);
		expect(await loadFacts({ store }, siteInput(SITE_B))).toBeNull();
	});

	it('hands the policy port the organisation and the site from the rows', async () => {
		const policy = vi.fn(async () => []);
		const { store } = makeStore(data({ members: [member(A, 'owner')] }));
		await loadFacts({ store, policy }, siteInput(SITE_A));
		expect(policy).toHaveBeenCalledWith({ orgId: A, siteId: SITE_A });
	});
});

describe('a store that answers with rows of another organisation', () => {
	it('is not believed: the membership and grants must belong to the organisation asked about', async () => {
		const rows = data({
			members: [member(A, 'owner')],
			grants: [siteGrant(SITE_A, 'site-admin', A)]
		});
		const { store } = makeStore(rows);
		store.member = async () => ({ orgId: A, role: 'owner' });
		store.siteGrants = async () => rows.grants;
		expect(await loadFacts({ store }, orgInput(B))).toBeNull();
		expect(await loadFacts({ store }, siteInput(SITE_B))).toBeNull();
	});
});

describe('delegation', () => {
	const agencyAdmin = [member(AGENCY, 'admin')];
	const deps = (rows: Data, extra: Partial<FactsDeps> = {}): FactsDeps => ({
		store: makeStore(rows).store,
		...extra
	});

	it('reaches the client site through an accepted delegation and audits both organisations', async () => {
		const loaded = await loadFacts(
			deps(data({ members: agencyAdmin, delegations: [delegation()] })),
			siteInput(SITE_A)
		);
		expect(loaded?.facts.agencyMemberships).toEqual([{ orgId: AGENCY, role: 'admin' }]);
		expect(loaded?.facts.membership).toBeUndefined();
		const decision = authorize({
			principal: user(),
			action: 'site.deploy',
			resource: loaded!.resource,
			facts: loaded!.facts
		});
		expect(decision).toMatchObject({ allow: true, via: 'delegation', audit: [A, AGENCY] });
	});

	it('limits a one-site delegation to that site', async () => {
		const rows = data({ members: agencyAdmin, delegations: [delegation({ sites: [SITE_A] })] });
		const own = await loadFacts(deps(rows), siteInput(SITE_A));
		const other = await loadFacts(deps(rows), siteInput(SITE_A2));
		const decide = (loaded: typeof own) =>
			authorize({
				principal: user(),
				action: 'site.read',
				resource: loaded!.resource,
				facts: loaded!.facts
			});
		expect(decide(own).allow).toBe(true);
		expect(decide(other)).toMatchObject({ allow: false, reason: 'forbidden' });
	});

	it.each([
		['revoked', { status: 'revoked' as const }],
		['not yet accepted', { status: 'pending' as const }],
		['expired', { expiresAt: T0 - 1 }]
	])('gives no access through a %s delegation', async (_name, over) => {
		const rows = data({ delegations: [delegation(over)] });
		expect(
			await loadFacts(deps({ ...rows, members: agencyAdmin }), siteInput(SITE_A))
		).toBeNull();
		const withOwn = await loadFacts(
			deps({ ...rows, members: [...agencyAdmin, member(A, 'viewer')] }),
			siteInput(SITE_A)
		);
		expect(withOwn?.facts.delegations).toEqual([]);
		expect(withOwn?.facts.agencyMemberships).toEqual([]);
	});

	it('ignores a delegation to an agency the caller is not a member of', async () => {
		const rows = data({
			members: [member(AGENCY, 'admin', OTHER)],
			delegations: [delegation()]
		});
		expect(await loadFacts(deps(rows), siteInput(SITE_A))).toBeNull();
	});

	it('ignores a delegation row that belongs to another client organisation', async () => {
		const rows = data({
			members: [member(AGENCY, 'admin'), member(A, 'viewer')],
			delegations: [delegation({ clientOrgId: B })]
		});
		const store = makeStore(rows).store;
		store.delegations = async () => rows.delegations;
		const loaded = await loadFacts({ store }, siteInput(SITE_A));
		expect(loaded?.facts.delegations).toEqual([]);
	});

	it('denies with org_suspended when the agency is suspended', async () => {
		const rows = data({ members: agencyAdmin, delegations: [delegation()] });
		const loaded = await loadFacts(
			deps(rows, { suspensions: async () => ({ orgIds: [AGENCY], user: false }) }),
			siteInput(SITE_A)
		);
		expect(loaded?.facts.flags.suspendedOrgIds).toEqual([AGENCY]);
		expect(
			authorize({
				principal: user(),
				action: 'site.read',
				resource: loaded!.resource,
				facts: loaded!.facts
			})
		).toEqual({ allow: false, reason: 'org_suspended' });
	});
});

describe('suspension', () => {
	it('asks about the organisation and every agency and keeps only those it asked about', async () => {
		const asked: (readonly string[])[] = [];
		const rows = data({
			members: [member(A, 'owner'), member(AGENCY, 'admin')],
			delegations: [delegation()]
		});
		const loaded = await loadFacts(
			{
				store: makeStore(rows).store,
				suspensions: async ({ orgIds }) => (
					asked.push(orgIds),
					{ orgIds: [A, B], user: false }
				)
			},
			orgInput(A)
		);
		expect(asked).toEqual([[A, AGENCY]]);
		expect(loaded?.facts.flags.suspendedOrgIds).toEqual([A]);
		expect(
			authorize({
				principal: user(),
				action: 'site.deploy',
				resource: { orgId: A, siteId: SITE_A },
				facts: loaded!.facts
			})
		).toEqual({ allow: false, reason: 'org_suspended' });
	});

	it('denies a suspended user with user_suspended', async () => {
		const { store } = makeStore(data({ members: [member(A, 'owner')] }));
		const loaded = await loadFacts(
			{ store, suspensions: async () => ({ orgIds: [], user: true }) },
			orgInput(A)
		);
		expect(
			authorize({
				principal: user(),
				action: 'org.read',
				resource: loaded!.resource,
				facts: loaded!.facts
			})
		).toEqual({ allow: false, reason: 'user_suspended' });
	});
});

describe('api key principal', () => {
	const hasKey = async (
		over: { expiresAt?: number; revokedAt?: number; scopes?: string[] } = {}
	) => {
		const generated = await generateApiKey({
			scopes: ['site.read'],
			expiry: '30d',
			now: T0
		});
		const services = {
			keys: {
				find: async () => ({
					keyId: 'key-1',
					issuerId: ME,
					orgId: A,
					keyHash: generated.data.keyHash,
					scopes: over.scopes ?? ['site.read'],
					expiresAt: over.expiresAt ?? T0 + 1_000_000,
					...(over.revokedAt === undefined ? {} : { revokedAt: over.revokedAt })
				})
			}
		} as unknown as AuthServices;
		const principal = await resolveCredential(services, {
			kind: 'bearer',
			token: generated.token
		});
		expect(principal?.kind).toBe('key');
		return principal as Principal;
	};

	const unresolved: Principal = { kind: 'key', keyId: 'key-9', issuerId: ME };

	it('describes the issuer and attaches the key record', async () => {
		const principal = await hasKey();
		const { store, calls } = makeStore(data({ members: [member(A, 'developer')] }));
		const loaded = await loadFacts({ store }, siteInput(SITE_A, principal));
		expect(loaded?.facts.membership).toEqual({ orgId: A, role: 'developer' });
		expect(loaded?.facts.key).toMatchObject({ id: 'key-1', scopes: ['site.read'] });
		expect(calls.filter((c) => c.method === 'member').every((c) => c.args[1] === ME)).toBe(
			true
		);
		expect(
			authorize({
				principal,
				action: 'site.read',
				resource: loaded!.resource,
				facts: loaded!.facts
			})
		).toMatchObject({ allow: true, via: 'organisation' });
		expect(
			authorize({
				principal,
				action: 'site.deploy',
				resource: loaded!.resource,
				facts: { ...loaded!.facts, budgetExceeded: [] }
			})
		).toEqual({ allow: false, reason: 'key_scope' });
	});

	it('finds nothing for a key the resolver never saw', async () => {
		const { store, calls } = makeStore(data({ members: [member(A, 'owner')] }));
		expect(await loadFacts({ store }, siteInput(SITE_A, unresolved))).toBeNull();
		expect(await loadFacts({ store }, orgInput(A, unresolved))).toBeNull();
		expect(calls).toEqual([]);
	});

	it('finds nothing for a key revoked after it was resolved', async () => {
		const principal = await hasKey({ revokedAt: T0 + 500 });
		const { store, calls } = makeStore(data({ members: [member(A, 'owner')] }));
		expect(await loadFacts({ store }, siteInput(SITE_A, principal))).not.toBeNull();
		clock.advance(500);
		calls.length = 0;
		expect(await loadFacts({ store }, siteInput(SITE_A, principal))).toBeNull();
		expect(calls).toEqual([]);
	});

	it('finds nothing for a key that expired after it was resolved', async () => {
		const principal = await hasKey({ expiresAt: T0 + 500 });
		const { store } = makeStore(data({ members: [member(A, 'owner')] }));
		clock.advance(500);
		expect(await loadFacts({ store }, orgInput(A, principal))).toBeNull();
	});

	it('finds nothing when the issuer has no relationship to the organisation', async () => {
		const principal = await hasKey();
		const { store } = makeStore(data({ members: [member(A, 'owner')] }));
		expect(await loadFacts({ store }, siteInput(SITE_B, principal))).toBeNull();
		expect(await loadFacts({ store }, orgInput(B, principal))).toBeNull();
	});

	it('never asks the support port about a key', async () => {
		const principal = await hasKey();
		const support = vi.fn(async () => null);
		const { store } = makeStore(data({ members: [member(A, 'owner')] }));
		await loadFacts({ store, support }, orgInput(A, principal));
		expect(support).not.toHaveBeenCalled();
	});
});

describe('platform support', () => {
	const admin = { admin: true, access: true, permissions: ['support' as const] };
	const grant = (over: Partial<{ orgId: string; expiresAt: number }> = {}) => ({
		orgId: B,
		role: 'viewer' as const,
		expiresAt: T0 + 60_000,
		...over
	});

	it('reaches the organisation through a live support grant and audits it', async () => {
		const { store } = makeStore(data());
		const loaded = await loadFacts(
			{ store, support: async () => ({ platform: admin, supportGrant: grant() }) },
			orgInput(B)
		);
		expect(loaded).not.toBeNull();
		expect(
			authorize({
				principal: user(),
				action: 'org.read',
				resource: loaded!.resource,
				facts: loaded!.facts
			})
		).toMatchObject({ allow: true, via: 'support-grant', audit: [B] });
	});

	it('finds nothing for an expired support grant, another organisation grant or a missing platform flag', async () => {
		const { store } = makeStore(data());
		const attempts = [
			{ platform: admin, supportGrant: grant({ expiresAt: T0 }) },
			{ platform: admin, supportGrant: grant({ orgId: A }) },
			{ platform: { ...admin, access: false }, supportGrant: grant() },
			{ platform: { ...admin, permissions: [] }, supportGrant: grant() },
			{ supportGrant: grant() }
		];
		for (const standing of attempts) {
			expect(
				await loadFacts({ store, support: async () => standing }, orgInput(B))
			).toBeNull();
		}
	});
});

describe('site lookup across shards', () => {
	const shards = (...rows: { id: string; organization_id: string }[][]) =>
		({
			allAllShards: async () =>
				rows.map((results) => ({ success: true, results, meta: { duration: 0 } }))
		}) as unknown as CollegeDBClient;

	it('returns the one row that exists', async () => {
		const db = shards([], [{ id: SITE_A, organization_id: A }]);
		expect(await findSiteHome(db, SITE_A)).toEqual({ id: SITE_A, organizationId: A });
	});

	it('finds nothing for no row or for the same id on two shards', async () => {
		expect(await findSiteHome(shards([], []), SITE_A)).toBeNull();
		const both = shards(
			[{ id: SITE_A, organization_id: A }],
			[{ id: SITE_A, organization_id: B }]
		);
		expect(await findSiteHome(both, SITE_A)).toBeNull();
	});

	it('stops with a typed error when a shard does not answer', async () => {
		const db = {
			allAllShards: async () => [
				{
					success: true,
					results: [{ id: SITE_A, organization_id: A }],
					meta: { duration: 0 }
				},
				{ success: false, results: [], meta: { duration: 0 }, error: 'down' }
			]
		} as unknown as CollegeDBClient;
		await expect(findSiteHome(db, SITE_A)).rejects.toBeInstanceOf(SiteLookupError);
	});
});
