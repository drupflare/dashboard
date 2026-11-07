import type { CollegeDBClient } from '@earth-app/collegedb';
import { getRequestHeader, type EventHandler } from 'h3';
import { afterEach, describe, expect, it } from 'vitest';
import operations from '../../../../src/server/api/v1/admin/operations.get';
import organizations from '../../../../src/server/api/v1/admin/organizations.get';
import overview from '../../../../src/server/api/v1/admin/overview.get';
import sites from '../../../../src/server/api/v1/admin/sites.get';
import users from '../../../../src/server/api/v1/admin/users.get';
import { platformStanding } from '../../../../src/server/services/boot';
import { loadFacts, type FactsStore } from '../../../../src/server/services/facts';
import { setOrganizationServices } from '../../../../src/server/services/organizations';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { asKey, asUser, send as sendRequest, setup } from '../fixtures/harness';

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
			operations: { succeeded: 5 }
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
