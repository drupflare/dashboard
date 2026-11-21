import type { CollegeDBClient } from '@earth-app/collegedb';
import { getRequestHeader, type EventHandler } from 'h3';
import type { SQLInputValue } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import abuseState from '../../../../src/server/api/v1/admin/abuse/[id]/state.put';
import abuseOpen from '../../../../src/server/api/v1/admin/abuse/index.post';
import capacity from '../../../../src/server/api/v1/admin/capacity.get';
import flagSet from '../../../../src/server/api/v1/admin/flags/[key].put';
import mail from '../../../../src/server/api/v1/admin/mail.get';
import operations from '../../../../src/server/api/v1/admin/operations.get';
import organizations from '../../../../src/server/api/v1/admin/organizations.get';
import organizationDetail from '../../../../src/server/api/v1/admin/organizations/[id].get';
import overview from '../../../../src/server/api/v1/admin/overview.get';
import sites from '../../../../src/server/api/v1/admin/sites.get';
import users from '../../../../src/server/api/v1/admin/users.get';
import { addMember, createOrganization } from '../../../../src/server/db/repos/organization';
import { platformStanding } from '../../../../src/server/services/boot';
import {
	resetCapacityServices,
	setCapacityServices,
	type CloudflareReads
} from '../../../../src/server/services/capacity';
import { loadFacts, type FactsStore } from '../../../../src/server/services/facts';
import { setFlag } from '../../../../src/server/services/flags';
import { setOrganizationServices } from '../../../../src/server/services/organizations';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import type { PlatformPermission } from '../../../../src/shared/permissions';
import { ORG } from '../../domain/fixtures';
import { asKey, asUser, send as sendRequest, setup } from '../fixtures/harness';
import { addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const ADMIN = 'admin@example.test';

type Row = Record<string, unknown>;
interface World {
	role: string | null;
	userRows?: Row[];
	siteRows?: Row[];
}

// a database that answers by the shape of the query, and records the limit it was asked for
function fakeDb(world: World) {
	const asked: unknown[][] = [];
	const db = {
		async first(_key: string, sql: string) {
			if (sql.includes('COUNT')) return { n: 4 };
			if (sql.includes('release_rollouts')) return null;
			return {
				id: 'user-1',
				email: ADMIN,
				display_name: null,
				platform_role: world.role,
				created_at: 1,
				updated_at: 1
			};
		},
		async all(_key: string, sql: string, params: unknown[]) {
			asked.push(params);
			return { results: sql.includes('FROM users') ? (world.userRows ?? []) : [] };
		},
		async allAllShards(sql: string, params: unknown[] = []) {
			asked.push(params);
			let results: Row[] = [];
			if (sql.includes('COUNT(*) AS n FROM organizations')) results = [{ n: 2 }];
			else if (sql.includes('GROUP BY state')) results = [{ key: 'active', n: 3 }];
			else if (sql.includes('GROUP BY status')) results = [{ key: 'succeeded', n: 5 }];
			else if (sql.includes('FROM sites')) results = world.siteRows ?? [];
			return [{ success: true, results }];
		}
	};
	return { db: db as unknown as CollegeDBClient, asked };
}

const noStore = {} as FactsStore;

function world(input: World) {
	const { db, asked } = fakeDb(input);
	const getDb = async () => db;
	setOrganizationServices({ getDb });
	setup({
		deps: {
			load: (load) => loadFacts({ store: noStore, platform: platformStanding(getDb) }, load),
			access: async (event) => {
				const email = getRequestHeader(event, 'x-test-access');
				return email ? { email } : null;
			}
		}
	});
	return asked;
}

// the route is the path without its query; the request carries the whole address
const send = (handler: EventHandler, address: string, headers: Record<string, string>) =>
	sendRequest(handler, address.split('?')[0] as string, { path: address, headers });

const inside = { ...asUser, 'x-test-access': ADMIN };

afterEach(() => {
	resetApiDeps();
	resetCapacityServices();
	setOrganizationServices(null);
});

describe('admin routes: who gets in', () => {
	it('lets an admin with a verified Access login for the same address read the totals', async () => {
		world({ role: 'admin' });
		const reply = await send(overview, '/api/v1/admin/overview', inside);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			users: 4,
			organizations: 2,
			sites: { active: 3 },
			operations: { succeeded: 5 },
			work: { running: 0, failedLastDay: 0 },
			abuseOpen: 4,
			switchesOn: [],
			rollout: null
		});
	});

	it('refuses an admin whose Access login is missing or for another address', async () => {
		world({ role: 'admin' });
		expect((await send(overview, '/api/v1/admin/overview', asUser)).status).toBe(403);
		const other = { ...asUser, 'x-test-access': 'someone@example.test' };
		expect((await send(overview, '/api/v1/admin/overview', other)).status).toBe(403);
	});

	it('refuses a person with an Access login and no role', async () => {
		world({ role: null });
		expect((await send(overview, '/api/v1/admin/overview', inside)).status).toBe(403);
	});

	it('refuses a role the platform does not know', async () => {
		world({ role: 'owner' });
		expect((await send(overview, '/api/v1/admin/overview', inside)).status).toBe(403);
	});

	it('answers 401 with no session, and refuses an API key even from an admin', async () => {
		world({ role: 'admin' });
		expect(
			(await send(overview, '/api/v1/admin/overview', { 'x-test-access': ADMIN })).status
		).toBe(401);
		const keyed = { ...asKey, 'x-test-access': ADMIN };
		expect((await send(overview, '/api/v1/admin/overview', keyed)).status).toBe(403);
	});
});

describe('admin lists', () => {
	it('returns the newest users with a cursor when more rows follow', async () => {
		const rows = [3, 2, 1].map((n) => ({
			id: `user-${n}`,
			email: `u${n}@example.test`,
			display_name: null,
			platform_role: null,
			created_at: n * 1000
		}));
		const asked = world({ role: 'admin', userRows: rows });
		const reply = await send(users, '/api/v1/admin/users?limit=2', inside);
		expect(reply.status).toBe(200);
		const body = reply.json as { items: { id: string }[]; nextBefore: number | null };
		expect(body.items.map((item) => item.id)).toEqual(['user-3', 'user-2']);
		expect(body.nextBefore).toBe(2000);
		expect(asked.at(-1)?.[1]).toBe(3);
	});

	it('returns no cursor on the last page and never includes a secret field', async () => {
		world({
			role: 'admin',
			userRows: [
				{
					id: 'user-1',
					email: ADMIN,
					display_name: 'Ada',
					platform_role: 'admin',
					created_at: 1
				}
			]
		});
		const reply = await send(users, '/api/v1/admin/users', inside);
		const body = reply.json as { items: Row[]; nextBefore: number | null };
		expect(body.nextBefore).toBeNull();
		expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
			'createdAt',
			'displayName',
			'email',
			'id',
			'platformRole'
		]);
	});

	it('merges shard rows for sites, newest first', async () => {
		world({
			role: 'admin',
			siteRows: [
				{
					id: 'site_a',
					organization_id: 'org_a',
					name: 'a',
					kind: 'drupal',
					plane: 'managed',
					state: 'active',
					primary_hostname: 'a.drupflare.app',
					created_at: 10
				},
				{
					id: 'site_b',
					organization_id: 'org_a',
					name: 'b',
					kind: 'drupal',
					plane: 'managed',
					state: 'active',
					primary_hostname: null,
					created_at: 20
				}
			]
		});
		const reply = await send(sites, '/api/v1/admin/sites', inside);
		expect((reply.json as { items: { id: string }[] }).items.map((i) => i.id)).toEqual([
			'site_b',
			'site_a'
		]);
	});

	it('answers an empty page for organizations and operations on an empty platform', async () => {
		world({ role: 'admin' });
		for (const [handler, path] of [
			[organizations, '/api/v1/admin/organizations'],
			[operations, '/api/v1/admin/operations']
		] as const) {
			const reply = await send(handler, path, inside);
			expect(reply.json).toEqual({ items: [], nextBefore: null });
		}
	});

	it('rejects a limit outside 1 to 100', async () => {
		world({ role: 'admin' });
		expect((await send(users, '/api/v1/admin/users?limit=0', inside)).status).toBe(400);
		expect((await send(users, '/api/v1/admin/users?limit=101', inside)).status).toBe(400);
	});
});

describe('admin capacity', () => {
	const reads = (over: Partial<CloudflareReads> = {}): CloudflareReads => ({
		credits: async () => ({
			state: 'ok',
			currency: 'USD',
			balanceCents: 999_958,
			originalCents: 1_000_000,
			usedCents: 42,
			daysRemaining: 363,
			validFrom: null,
			validTo: null,
			projectedDepletion: null
		}),
		usage: async () => ({
			state: 'ok',
			currency: 'USD',
			from: '2026-11-01',
			through: '2026-11-12',
			totalCents: 500,
			services: [{ name: 'R2', cents: 500 }]
		}),
		headroom: async () => ({
			state: 'ok',
			kvNamespaces: 3,
			kvLimit: 1000,
			buckets: 2,
			scripts: 4,
			databases: 1,
			rate: { remaining: 1100, quota: 1200, resetSeconds: 250, windowSeconds: 300 }
		}),
		...over
	});

	function install(upstream: CloudflareReads | null) {
		world({ role: 'admin' });
		setCapacityServices({
			getDb: async () => fakeDb({ role: 'admin' }).db,
			reads: upstream
		});
	}

	it('returns the capacity to an admin with a verified Access login', async () => {
		install(reads());
		const reply = await send(capacity, '/api/v1/admin/capacity', inside);
		expect(reply.status).toBe(200);
		expect(reply.headers.get('cache-control')).toBe('no-store');
		expect(reply.json).toMatchObject({
			credits: { state: 'ok', balanceCents: 999_958 },
			usage: { state: 'ok', services: [{ name: 'R2', cents: 500 }] },
			headroom: { state: 'ok', kvNamespaces: 3, kvLimit: 1000 },
			work: { running: 0, failedLastDay: 0, recentFailures: [], sites: { active: 3 } }
		});
	});

	it('answers a plain refusal for the credits and still returns everything else', async () => {
		const { BillingAccessError } =
			await import('../../../../src/server/integrations/cloudflare-billing');
		install(
			reads({
				credits: async () => {
					throw new BillingAccessError();
				}
			})
		);
		const reply = await send(capacity, '/api/v1/admin/capacity', inside);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			credits: { state: 'no_billing_access' },
			headroom: { state: 'ok' },
			work: { sites: { active: 3 } }
		});
	});

	it('refuses a person with no Access login, no role, an unknown role or an API key', async () => {
		install(reads());
		expect((await send(capacity, '/api/v1/admin/capacity', asUser)).status).toBe(403);
		expect(
			(await send(capacity, '/api/v1/admin/capacity', { 'x-test-access': ADMIN })).status
		).toBe(401);
		expect(
			(await send(capacity, '/api/v1/admin/capacity', { ...asKey, 'x-test-access': ADMIN }))
				.status
		).toBe(403);
		for (const role of [null, 'owner']) {
			world({ role });
			setCapacityServices({ getDb: async () => fakeDb({ role }).db, reads: reads() });
			expect((await send(capacity, '/api/v1/admin/capacity', inside)).status).toBe(403);
		}
	});

	it('does not call Cloudflare for a refused request', async () => {
		let called = 0;
		install(
			reads({
				credits: async () => {
					called++;
					throw new Error('should not run');
				}
			})
		);
		await send(capacity, '/api/v1/admin/capacity', asUser);
		expect(called).toBe(0);
	});
});

// the console routes run on the real schema; the platform permissions can be pinned per test, so each
// route's own gate is judged apart from the role table
async function consoleWorld(
	options: { role?: string | null; permissions?: PlatformPermission[]; stepUp?: boolean } = {}
) {
	const { raw, client } = sqliteClient();
	// one shard is the whole platform here, so every-shard reads answer from the same database
	const shardless = Object.assign(client, {
		allAllShards: async (sql: string, params: SQLInputValue[] = []) => [
			{ success: true, results: raw.prepare(sql).all(...params) }
		]
	});
	const getDb = async () => shardless as unknown as CollegeDBClient;
	setOrganizationServices({ getDb });
	raw.prepare(
		`INSERT INTO users (id, email, display_name, platform_role, created_at, updated_at)
			 VALUES ('user-1', ?, NULL, ?, 1, 1)`
	).run(ADMIN, options.role ?? null);
	setup({
		deps: {
			load: async (load) => {
				const loaded = await loadFacts(
					{ store: noStore, platform: platformStanding(getDb) },
					load
				);
				if (loaded === null) return loaded;
				const platform = options.permissions
					? { admin: true, access: true, permissions: options.permissions }
					: loaded.facts.platform;
				return {
					...loaded,
					facts: {
						...loaded.facts,
						platform,
						...(options.stepUp ? { stepUpAt: Date.now() } : {})
					}
				};
			},
			access: async (event) => {
				const email = getRequestHeader(event, 'x-test-access');
				return email ? { email } : null;
			}
		}
	});
	return { raw, client: shardless as unknown as CollegeDBClient };
}

const call = (handler: EventHandler, route: string, method: string, path: string, json?: unknown) =>
	sendRequest(handler, route, { method, path, headers: inside, json });

describe('admin consoles: abuse routes', () => {
	it('refuses the abuse routes to a person with no platform role', async () => {
		const { raw } = await consoleWorld({ role: null });
		addReadySite(raw, ORG, 'site-1');
		const reply = await call(abuseOpen, '/api/v1/admin/abuse', 'POST', '/api/v1/admin/abuse', {
			siteId: 'site-1',
			reason: 'spam'
		});
		expect(reply.status).toBe(403);
	});

	it('opens a report and moves it to actioned, then refuses a move out of a final state', async () => {
		const { raw } = await consoleWorld({ role: 'admin', permissions: ['read', 'support'] });
		addReadySite(raw, ORG, 'site-1');
		const opened = await call(abuseOpen, '/api/v1/admin/abuse', 'POST', '/api/v1/admin/abuse', {
			siteId: 'site-1',
			reason: 'spam'
		});
		expect(opened.status).toBe(201);
		const id = (opened.json as { id: string }).id;
		const path = `/api/v1/admin/abuse/${id}/state`;
		const reviewing = await call(abuseState, '/api/v1/admin/abuse/:id/state', 'PUT', path, {
			state: 'reviewing'
		});
		expect(reviewing.status).toBe(200);
		const actioned = await call(abuseState, '/api/v1/admin/abuse/:id/state', 'PUT', path, {
			state: 'actioned'
		});
		expect(actioned.status).toBe(200);
		const back = await call(abuseState, '/api/v1/admin/abuse/:id/state', 'PUT', path, {
			state: 'open'
		});
		expect(back.status).toBe(409);
	});

	it('lets a platform admin open an abuse report with the admin role as stored', async () => {
		const { raw } = await consoleWorld({ role: 'admin' });
		addReadySite(raw, ORG, 'site-1');
		const reply = await call(abuseOpen, '/api/v1/admin/abuse', 'POST', '/api/v1/admin/abuse', {
			siteId: 'site-1',
			reason: 'spam'
		});
		expect(reply.status).toBe(201);
	});
});

describe('admin consoles: switch routes', () => {
	const path = '/api/v1/admin/flags/signups.paused';
	const set = (value: boolean) =>
		call(flagSet, '/api/v1/admin/flags/:key', 'PUT', path, { value });

	it('needs step-up before a switch changes, and changes it once step-up is fresh', async () => {
		await consoleWorld({ role: 'admin', permissions: ['read', 'infrastructure'] });
		expect((await set(true)).status).toBe(403);
		await consoleWorld({
			role: 'admin',
			permissions: ['read', 'infrastructure'],
			stepUp: true
		});
		const reply = await set(true);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ key: 'signups.paused', value: true });
	});

	it('refuses a switch change to a person with no platform role', async () => {
		await consoleWorld({ role: null, stepUp: true });
		expect((await set(true)).status).toBe(403);
	});

	it('lets a platform admin with the admin role as stored change a switch after step-up', async () => {
		await consoleWorld({ role: 'admin', stepUp: true });
		expect((await set(true)).status).toBe(200);
	});
});

describe('admin consoles: organisation detail and mail routes', () => {
	it('answers the counts of one organisation and no site content', async () => {
		const { raw, client } = await consoleWorld({ role: 'admin', permissions: ['read'] });
		const org = await createOrganization(client, {
			name: 'Campus',
			personal: false,
			createdBy: 'user-1'
		});
		await addMember(client, org.id, { userId: 'user-1', role: 'owner' });
		addReadySite(raw, org.id, 'site-9');
		const reply = await call(
			organizationDetail,
			'/api/v1/admin/organizations/:id',
			'GET',
			`/api/v1/admin/organizations/${org.id}`
		);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			id: org.id,
			name: 'Campus',
			members: 1,
			sites: { active: 1 },
			plan: null,
			subscription: null
		});
		expect(reply.text).not.toContain('site-9');
	});

	it('answers 404 for an organisation that does not exist', async () => {
		await consoleWorld({ role: 'admin', permissions: ['read'] });
		const reply = await call(
			organizationDetail,
			'/api/v1/admin/organizations/:id',
			'GET',
			'/api/v1/admin/organizations/org_missing'
		);
		expect(reply.status).toBe(404);
	});

	it('reports the mail categories and follows the notifications switch', async () => {
		const { client, raw } = await consoleWorld({ role: 'admin', permissions: ['read'] });
		const insert = raw.prepare(
			'INSERT INTO mail_log (category, class, status, at) VALUES (?, ?, ?, ?)'
		);
		const now = Date.now();
		insert.run('budget-limit', 'essential', 'sent', now);
		insert.run('billing-info', 'optional', 'sent', now);
		insert.run('billing-info', 'optional', 'skipped-paused', now);
		insert.run('budget-limit', 'essential', 'failed', now);
		insert.run('billing-info', 'optional', 'sent', 1);
		const before = await call(mail, '/api/v1/admin/mail', 'GET', '/api/v1/admin/mail');
		expect(before.status).toBe(200);
		expect(before.json).toMatchObject({
			notificationsPaused: false,
			today: { sent: 2, failed: 1, skippedPaused: 1, skippedPreference: 0 }
		});
		await setFlag(client, {
			key: 'notifications.paused',
			value: true,
			principal: { kind: 'user', userId: 'user-1' },
			now: Date.now()
		});
		const after = await call(mail, '/api/v1/admin/mail', 'GET', '/api/v1/admin/mail');
		expect(after.json).toMatchObject({ notificationsPaused: true });
	});

	it('refuses the mail and organisation routes to a person with no platform role', async () => {
		await consoleWorld({ role: null });
		expect((await call(mail, '/api/v1/admin/mail', 'GET', '/api/v1/admin/mail')).status).toBe(
			403
		);
		const detail = await call(
			organizationDetail,
			'/api/v1/admin/organizations/:id',
			'GET',
			`/api/v1/admin/organizations/org-1`
		);
		expect(detail.status).toBe(403);
	});
});
