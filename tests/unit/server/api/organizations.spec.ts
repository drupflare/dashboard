import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterEach, describe, expect, it } from 'vitest';
import organizations from '../../../../src/server/api/v1/me/organizations.get';
import { setOrganizationServices } from '../../../../src/server/services/organizations';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh } from '../../domain/fixtures';
import { asKey, asOtherUser, asUser, send, setup } from '../fixtures/harness';

const ROUTE = '/api/v1/me/organizations';

interface Row {
	userId: string;
	id: string;
	name: string;
	personal: number;
	role: string;
}

const ROWS: Row[] = [
	{ userId: 'user-1', id: 'org-acme', name: 'Acme', personal: 0, role: 'admin' },
	{ userId: 'user-1', id: 'org-personal', name: 'Ada personal', personal: 1, role: 'owner' },
	{ userId: 'user-1', id: 'org-bolt', name: 'Bolt', personal: 0, role: 'viewer' },
	{ userId: 'user-2', id: 'org-other', name: 'Other person', personal: 0, role: 'owner' }
];

// the query is covered against real D1 in the bindings test; this fake keeps the user filter and the row shape
function fakeDb(rows: Row[]): CollegeDBClient {
	return {
		allAllShards: async (_sql: string, bindings: unknown[] = []) => [
			{
				success: true,
				results: rows
					.filter((row) => row.userId === bindings[0])
					.map(({ id, name, personal, role }) => ({ id, name, personal, role }))
			}
		]
	} as unknown as CollegeDBClient;
}

function world(options: { key?: string[]; rows?: Row[] } = {}) {
	setOrganizationServices({ getDb: async () => fakeDb(options.rows ?? ROWS) });
	setup({
		facts: () =>
			facts({
				...fresh,
				...(options.key ? { key: { id: 'key-1', scopes: options.key } } : {})
			})
	});
}

interface Body {
	items: { id: string; name: string; personal: boolean; role: string }[];
	nextCursor: string | null;
}

afterEach(() => {
	setOrganizationServices(null);
	resetApiDeps();
});

describe('GET /api/v1/me/organizations', () => {
	it('lists both organisations with their roles, the personal one first', async () => {
		world();
		const reply = await send(organizations, ROUTE, { path: ROUTE, headers: asUser });
		expect(reply.status).toBe(200);
		const body = reply.json as Body;
		expect(body.items).toEqual([
			{ id: 'org-personal', name: 'Ada personal', personal: true, role: 'owner' },
			{ id: 'org-acme', name: 'Acme', personal: false, role: 'admin' },
			{ id: 'org-bolt', name: 'Bolt', personal: false, role: 'viewer' }
		]);
		expect(body.nextCursor).toBeNull();
	});

	it('never lists another person organisations', async () => {
		world();
		const reply = await send(organizations, ROUTE, { path: ROUTE, headers: asOtherUser });
		expect((reply.json as Body).items.map((org) => org.id)).toEqual(['org-other']);
	});

	it('answers an empty list for a person with no memberships', async () => {
		world({ rows: [] });
		const reply = await send(organizations, ROUTE, { path: ROUTE, headers: asUser });
		expect(reply.json).toEqual({ items: [], nextCursor: null });
	});

	it('pages with the cursor, one organisation at a time, each listed once', async () => {
		world();
		const names: string[] = [];
		let cursor: string | null = null;
		let pages = 0;
		do {
			const suffix = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`;
			const reply = await send(organizations, ROUTE, {
				path: `${ROUTE}?limit=1${suffix}`,
				headers: asUser
			});
			const body = reply.json as Body;
			pages += 1;
			names.push(...body.items.map((org) => org.name));
			cursor = body.nextCursor;
		} while (cursor !== null);
		expect(names).toEqual(['Ada personal', 'Acme', 'Bolt']);
		expect(pages).toBe(3);
	});

	it('refuses a malformed cursor or limit with a validation error', async () => {
		world();
		const badCursor = await send(organizations, ROUTE, {
			path: `${ROUTE}?cursor=!!!`,
			headers: asUser
		});
		const badLimit = await send(organizations, ROUTE, {
			path: `${ROUTE}?limit=0`,
			headers: asUser
		});
		expect(badCursor.status).toBe(400);
		expect(badLimit.status).toBe(400);
	});

	it('lists the issuer organisations for a key whose scopes allow account.read', async () => {
		world({ key: ['account.read'] });
		const reply = await send(organizations, ROUTE, { path: ROUTE, headers: asKey });
		expect((reply.json as Body).items.map((org) => org.id)).toEqual([
			'org-personal',
			'org-acme',
			'org-bolt'
		]);
	});

	it('refuses a key whose scopes do not allow account.read', async () => {
		world({ key: ['site.read'] });
		const reply = await send(organizations, ROUTE, { path: ROUTE, headers: asKey });
		expect(reply.status).toBe(403);
	});

	it('answers 401 for a key the resolver does not know', async () => {
		world({ key: ['account.read'] });
		const reply = await send(organizations, ROUTE, {
			path: ROUTE,
			headers: { authorization: 'Bearer dfk_unknown' }
		});
		expect(reply.status).toBe(401);
	});

	it('answers 501 until boot installs the organisation store', async () => {
		setup({ facts: () => facts({ ...fresh }) });
		const reply = await send(organizations, ROUTE, { path: ROUTE, headers: asUser });
		expect(reply.status).toBe(501);
		expect((reply.json as { code: string }).code).toBe('not_built');
	});
});
