import type { EventHandler } from 'h3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import entitlementRead from '../../../../src/server/api/v1/orgs/[orgId]/entitlement.get';
import operationRead from '../../../../src/server/api/v1/orgs/[orgId]/operations/[id].get';
import sitesList from '../../../../src/server/api/v1/orgs/[orgId]/sites/index.get';
import sitesCreate from '../../../../src/server/api/v1/orgs/[orgId]/sites/index.post';
import siteRead from '../../../../src/server/api/v1/sites/[id]/index.get';
import siteOperations from '../../../../src/server/api/v1/sites/[id]/operations.get';
import templates from '../../../../src/server/api/v1/templates/index.get';
import { FREE_PLAN_ID, derive } from '../../../../src/server/domain/entitlements';
import { loadFacts, type FactsStore } from '../../../../src/server/services/facts';
import { resetSiteServices, setSiteServices } from '../../../../src/server/services/sites';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import type { OrgRole } from '../../../../src/shared/permissions';
import { TEMPLATES } from '../../../../src/shared/templates';
import { DEPT, ORG, OTHER_ORG, facts, fresh, member } from '../../domain/fixtures';
import {
	asOtherUser,
	asUser,
	send as sendRequest,
	setup,
	type Reply,
	type Request as RequestInit
} from '../fixtures/harness';

const MINE = 'site_aaaaaaaa';
const OTHER_SITE = 'site_bbbbbbbb';
const OPERATION = 'op_aaaaaaaa';
const KEY_HEADER = { 'idempotency-key': 'create-0001' };
const createBody = { kind: 'drupal', name: 'quiet-river-stone' };

const send = (
	handler: EventHandler,
	route: string,
	req: Partial<RequestInit> = {}
): Promise<Reply> => sendRequest(handler, route, { path: route, ...req });

// the loader gives the caller's organisation for any id except one outside it, which has no result
function world(role: OrgRole | null = 'owner') {
	setup({
		deps: {
			load: async (input) => {
				if (input.params.id === OTHER_SITE) return null;
				const membership = role === null ? {} : member(role);
				return {
					resource: {
						orgId: ORG,
						departmentId: DEPT,
						...(input.params.id === undefined ? {} : { siteId: input.params.id })
					},
					facts: facts({ ...membership, ...fresh })
				};
			}
		}
	});
}

// an organisation that exists, with no relationship to the caller; the real loader answers null
const strangers: FactsStore = {
	organization: async (id) => ({ id }),
	site: async () => null,
	member: async () => null,
	siteGrants: async () => [],
	delegations: async () => []
};

function asStranger() {
	setup({ deps: { load: (input) => loadFacts({ store: strangers }, input) } });
}

const allowed = async () => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return { allow: true as const, entitlement: result.entitlement };
};

// every store and port call is recorded; the store itself must never be reached
function spiedServices() {
	const services = {
		getDb: vi.fn(async (): Promise<never> => {
			throw new Error('the store must not be reached');
		}),
		entitlements: { check: vi.fn(allowed) },
		startOperation: vi.fn(async () => undefined)
	};
	setSiteServices(services);
	return services;
}

afterEach(() => {
	resetSiteServices();
	resetApiDeps();
});

describe('GET /api/v1/templates', () => {
	it('lists every enabled template and marks the rest Coming Soon', async () => {
		world();
		const reply = await send(templates, '/api/v1/templates', { headers: asUser });
		expect(reply.status).toBe(200);
		const items = (reply.json as { items: { id: string; enabled: boolean }[] }).items;
		expect(items.filter((item) => item.enabled).map((item) => item.id)).toEqual(
			TEMPLATES.filter((template) => template.enabled).map((template) => template.id)
		);
		for (const id of ['wordpress', 'joomla']) {
			expect(items.find((item) => item.id === id)).toMatchObject({
				enabled: false,
				comingSoon: 'Coming Soon'
			});
		}
	});

	it('leaves the source notes and plan gates out of each entry', async () => {
		world();
		const reply = await send(templates, '/api/v1/templates', { headers: asUser });
		for (const item of (reply.json as { items: Record<string, unknown>[] }).items) {
			expect(Object.keys(item).sort()).toEqual(
				['category', 'comingSoon', 'enabled', 'free', 'id', 'name'].sort()
			);
		}
	});

	it('lets a viewer read the catalogue', async () => {
		world('viewer');
		const reply = await send(templates, '/api/v1/templates', { headers: asUser });
		expect(reply.status).toBe(200);
	});

	it('lets a signed-in user with no organisation read the catalogue', async () => {
		asStranger();
		const reply = await send(templates, '/api/v1/templates', { headers: asUser });
		expect(reply.status).toBe(200);
	});

	it('answers 401 without a session', async () => {
		world();
		const reply = await send(templates, '/api/v1/templates');
		expect(reply.status).toBe(401);
		expect(reply.json).toMatchObject({ code: 'unauthenticated' });
	});
});

describe('POST /api/v1/orgs/:orgId/sites', () => {
	const create = (headers: Record<string, string>, json: unknown = createBody) =>
		send(sitesCreate, '/api/v1/orgs/:orgId/sites', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites`,
			headers: { ...asUser, ...headers },
			json
		});

	it('refuses a viewer before anything is read or written', async () => {
		world('viewer');
		const reply = await create(KEY_HEADER);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ code: 'forbidden' });
	});

	it('needs an Idempotency-Key header', async () => {
		world();
		const reply = await create({});
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('refuses a body with a field the contract does not name', async () => {
		world();
		const reply = await create(KEY_HEADER, { ...createBody, account: 'acct' });
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('refuses a name that breaks the site name rules', async () => {
		world();
		const reply = await create(KEY_HEADER, { ...createBody, name: 'Not A Label' });
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation', details: { field: 'name' } });
	});

	it('refuses a reserved platform word as the hostname label', async () => {
		world();
		const reply = await create(KEY_HEADER, { ...createBody, hostnameLabel: 'admin' });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({
			code: 'unprocessable',
			details: { field: 'hostnameLabel', owner: 'nobody' }
		});
	});

	it('names the paid owner of a reserved suffix', async () => {
		world();
		const reply = await create(KEY_HEADER, { ...createBody, name: 'shop-staging' });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { owner: 'paid-managed' } });
	});

	it('answers 501 until the entitlement check is installed, and never allows', async () => {
		world();
		const reply = await create(KEY_HEADER);
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ code: 'not_built' });
	});

	it('refuses when the plan does not include the kind', async () => {
		world();
		setSiteServices({
			entitlements: { check: async () => ({ allow: false, reason: 'feature_not_included' }) }
		});
		const reply = await create(KEY_HEADER);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			code: 'forbidden',
			details: {
				requires: 'entitlement',
				feature: 'site.create',
				reason: 'feature_not_included'
			}
		});
	});

	it('answers 501 when the store is not installed, after the entitlement check passes', async () => {
		world();
		setSiteServices({ entitlements: { check: allowed } });
		const reply = await create(KEY_HEADER);
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ code: 'not_built' });
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		world();
		const services = spiedServices();
		const reply = await send(sitesCreate, '/api/v1/orgs/:orgId/sites', {
			method: 'POST',
			path: `/api/v1/orgs/${OTHER_ORG}/sites`,
			headers: { ...asUser, ...KEY_HEADER },
			json: createBody
		});
		expect(reply.status).toBe(404);
		expect(services.startOperation).not.toHaveBeenCalled();
		expect(services.getDb).not.toHaveBeenCalled();
	});

	it('answers 404 to a caller with no relationship to the path organisation, and starts nothing', async () => {
		asStranger();
		const services = spiedServices();
		const reply = await send(sitesCreate, '/api/v1/orgs/:orgId/sites', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites`,
			headers: { ...asUser, ...KEY_HEADER },
			json: createBody
		});
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
		expect(services.entitlements.check).not.toHaveBeenCalled();
		expect(services.startOperation).not.toHaveBeenCalled();
		expect(services.getDb).not.toHaveBeenCalled();
	});
});

describe('site and operation reads', () => {
	const reads: [string, EventHandler, string, string][] = [
		[
			'GET /api/v1/orgs/:orgId/sites',
			sitesList,
			'/api/v1/orgs/:orgId/sites',
			`/api/v1/orgs/${ORG}/sites`
		],
		['GET /api/v1/sites/:id', siteRead, '/api/v1/sites/:id', `/api/v1/sites/${MINE}`],
		[
			'GET /api/v1/sites/:id/operations',
			siteOperations,
			'/api/v1/sites/:id/operations',
			`/api/v1/sites/${MINE}/operations`
		],
		[
			'GET /api/v1/orgs/:orgId/operations/:id',
			operationRead,
			'/api/v1/orgs/:orgId/operations/:id',
			`/api/v1/orgs/${ORG}/operations/${OPERATION}`
		]
	];

	it.each(reads)(
		'%s answers 501 until the store is installed',
		async (_name, handler, route, path) => {
			world();
			const reply = await send(handler, route, { path, headers: asUser });
			expect(reply.status).toBe(501);
			expect(reply.json).toMatchObject({ code: 'not_built' });
		}
	);

	it('answers 404 for a site the loader finds no organisation for', async () => {
		world();
		const reply = await send(siteRead, '/api/v1/sites/:id', {
			path: `/api/v1/sites/${OTHER_SITE}`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
	});

	it('answers 403 to a signed-in user who is not a member', async () => {
		world(null);
		const reply = await send(siteRead, '/api/v1/sites/:id', {
			path: `/api/v1/sites/${MINE}`,
			headers: asOtherUser
		});
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ code: 'forbidden' });
	});
});

describe('GET /api/v1/orgs/:orgId/sites', () => {
	it('answers 404 to a caller with no relationship to the path organisation, and never reads', async () => {
		asStranger();
		const services = spiedServices();
		const reply = await send(sitesList, '/api/v1/orgs/:orgId/sites', {
			path: `/api/v1/orgs/${ORG}/sites`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
		expect(services.getDb).not.toHaveBeenCalled();
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		world();
		const services = spiedServices();
		const reply = await send(sitesList, '/api/v1/orgs/:orgId/sites', {
			path: `/api/v1/orgs/${OTHER_ORG}/sites`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(services.getDb).not.toHaveBeenCalled();
	});
});

describe('GET /api/v1/orgs/:orgId/entitlement', () => {
	const route = '/api/v1/orgs/:orgId/entitlement';
	const planOf = vi.fn(async () => {
		const result = derive(FREE_PLAN_ID);
		if (!result.ok) throw new Error(result.reason);
		return result.entitlement;
	});
	const billingAccountOf = vi.fn(async () => false);

	it('gives any member the plan, with the custom code feature off on the free plan', async () => {
		world('viewer');
		setSiteServices({ planOf, billingAccountOf });
		const reply = await send(entitlementRead, route, {
			path: `/api/v1/orgs/${ORG}/entitlement`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			planId: FREE_PLAN_ID,
			features: { customCode: false },
			billingAccount: false
		});
		expect(planOf).toHaveBeenCalledWith(ORG);
	});

	it('says whether the organization has a billing account', async () => {
		world('viewer');
		setSiteServices({ planOf, billingAccountOf: async () => true });
		const reply = await send(entitlementRead, route, {
			path: `/api/v1/orgs/${ORG}/entitlement`,
			headers: asUser
		});
		expect(reply.json).toMatchObject({ billingAccount: true });
	});

	it('answers 404 to a caller with no relationship to the path organisation, and never reads', async () => {
		asStranger();
		setSiteServices({ planOf });
		planOf.mockClear();
		const reply = await send(entitlementRead, route, {
			path: `/api/v1/orgs/${ORG}/entitlement`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(planOf).not.toHaveBeenCalled();
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		world();
		setSiteServices({ planOf });
		planOf.mockClear();
		const reply = await send(entitlementRead, route, {
			path: `/api/v1/orgs/${OTHER_ORG}/entitlement`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(planOf).not.toHaveBeenCalled();
	});

	it('answers 401 without a session', async () => {
		world();
		const reply = await send(entitlementRead, route, {
			path: `/api/v1/orgs/${ORG}/entitlement`
		});
		expect(reply.status).toBe(401);
	});
});

describe('GET /api/v1/orgs/:orgId/operations/:id', () => {
	it('answers 404 to a caller with no relationship to the path organisation, and never reads', async () => {
		asStranger();
		const services = spiedServices();
		const reply = await send(operationRead, '/api/v1/orgs/:orgId/operations/:id', {
			path: `/api/v1/orgs/${ORG}/operations/${OPERATION}`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
		expect(services.getDb).not.toHaveBeenCalled();
	});

	it('answers 404 when the loaded organisation is not the one in the path', async () => {
		world();
		const services = spiedServices();
		const reply = await send(operationRead, '/api/v1/orgs/:orgId/operations/:id', {
			path: `/api/v1/orgs/${OTHER_ORG}/operations/${OPERATION}`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(services.getDb).not.toHaveBeenCalled();
	});
});
