import type { EventHandler } from 'h3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import operationRead from '../../../src/server/api/v1/orgs/[orgId]/operations/[id].get';
import sitesList from '../../../src/server/api/v1/orgs/[orgId]/sites/index.get';
import sitesCreate from '../../../src/server/api/v1/orgs/[orgId]/sites/index.post';
import siteRead from '../../../src/server/api/v1/sites/[id]/index.get';
import siteOperations from '../../../src/server/api/v1/sites/[id]/operations.get';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getReadySite, markSiteReady } from '../../../src/server/db/repos/sites';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import {
	createSite,
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { ApiError } from '../../../src/shared/errors';
import { DEPT, ORG, OTHER_ORG, facts, fresh } from '../../unit/domain/fixtures';
import {
	asUser,
	send as sendRequest,
	setup,
	type Reply,
	type Request as RequestInit
} from '../../unit/server/fixtures/harness';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
});

afterAll(() => harness.close());

afterEach(() => {
	resetSiteServices();
	resetApiDeps();
});

const send = (
	handler: EventHandler,
	route: string,
	req: Partial<RequestInit> = {}
): Promise<Reply> => sendRequest(handler, route, { path: route, ...req });

// the caller is an owner of orgId; the loader gives that organisation for every id it is asked about
function asMember(orgId = ORG) {
	setup({
		deps: {
			load: async (input) => ({
				resource: {
					orgId,
					departmentId: DEPT,
					...(input.params.id === undefined ? {} : { siteId: input.params.id })
				},
				facts: facts({ membership: { orgId, role: 'owner' }, ...fresh })
			})
		}
	});
}

const CONFIG = {
	hostSuffix: 'drupflare.app',
	accountId: 'a'.repeat(32),
	releases: { drupal: 'v1.0.4', smoke: 'v1.0.4' }
};

const freeEntitlement = () => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

// the port answers yes, and every accepted start is recorded
function acceptingPort() {
	const started: EngineStartRequest[] = [];
	setSiteServices({
		getDb,
		entitlements: { check: async () => ({ allow: true, entitlement: freeEntitlement() }) },
		startOperation: async (request) => {
			started.push(request);
		},
		config: CONFIG
	});
	return started;
}

let counter = 0;
const key = () => `key-${++counter}-${Date.now()}`;

async function createFor(orgId: string, name: string) {
	const stored = await createSite(siteServices(), {
		orgId,
		userId: 'user-bindings',
		kind: 'drupal',
		name,
		hostnameLabel: undefined,
		idempotencyKey: key()
	});
	return { stored, siteId: stored.operation.targetIds[0] as string };
}

describe('createSite', () => {
	it('starts the operation and keeps the site out of reads until its create finishes', async () => {
		const started = acceptingPort();
		const { stored, siteId } = await createFor(ORG, 'quiet-river-stone');
		expect(stored.operation.status).toBe('planned');
		expect(started.map((request) => [request.workflow, request.id])).toEqual([
			['site-create', stored.operation.id]
		]);
		expect(await getReadySite(await getDb(), ORG, siteId)).toBeNull();
		const row = await env.DB.prepare(
			'SELECT primary_hostname, ready_at FROM sites WHERE id = ?'
		)
			.bind(siteId)
			.first<{ primary_hostname: string; ready_at: number | null }>();
		expect(row).toEqual({
			primary_hostname: 'quiet-river-stone.drupflare.app',
			ready_at: null
		});
	});

	it('fails the operation and answers unprocessable when the start is refused', async () => {
		acceptingPort();
		setSiteServices({
			startOperation: async () => {
				throw new Error('signed request refused');
			}
		});
		const error = await createSite(siteServices(), {
			orgId: ORG,
			userId: 'user-bindings',
			kind: 'drupal',
			name: 'refused-start-site',
			hostnameLabel: undefined,
			idempotencyKey: key()
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ code: 'unprocessable' });
		const operationId = (error as ApiError).details as { operationId: string };
		const row = await env.DB.prepare('SELECT status FROM operations WHERE id = ?')
			.bind(operationId.operationId)
			.first<{ status: string }>();
		expect(row?.status).toBe('failed');
	});

	it('fails the operation with not_built when the start port is not installed', async () => {
		setSiteServices({
			getDb,
			entitlements: { check: async () => ({ allow: true, entitlement: freeEntitlement() }) },
			config: CONFIG
		});
		const error = await createSite(siteServices(), {
			orgId: ORG,
			userId: 'user-bindings',
			kind: 'drupal',
			name: 'unstarted-site',
			hostnameLabel: undefined,
			idempotencyKey: key()
		}).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ code: 'not_built' });
	});

	it('starts a repeated key once and returns the first operation', async () => {
		const started = acceptingPort();
		const repeated = key();
		const args = {
			orgId: ORG,
			userId: 'user-bindings',
			kind: 'drupal' as const,
			name: 'repeat-key-site',
			hostnameLabel: undefined,
			idempotencyKey: repeated
		};
		const first = await createSite(siteServices(), args);
		const second = await createSite(siteServices(), args);
		expect(second.operation.id).toBe(first.operation.id);
		expect(started).toHaveLength(1);
	});
});

describe('routes over the store', () => {
	it('POST /sites answers 202, and a repeat replays it without a second start', async () => {
		const started = acceptingPort();
		asMember();
		const body = { kind: 'drupal', name: 'route-created-site' };
		const headers = { ...asUser, 'idempotency-key': 'route-create-0001' };
		const first = await send(sitesCreate, '/api/v1/orgs/:orgId/sites', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites`,
			headers,
			json: body
		});
		expect(first.status).toBe(202);
		const second = await send(sitesCreate, '/api/v1/orgs/:orgId/sites', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites`,
			headers,
			json: body
		});
		expect(second.status).toBe(202);
		expect(second.json).toEqual(first.json);
		expect(started).toHaveLength(1);
	});

	it('POST /sites answers 422 with the operation id when the start is refused', async () => {
		acceptingPort();
		setSiteServices({
			startOperation: async () => {
				throw new Error('refused');
			}
		});
		asMember();
		const reply = await send(sitesCreate, '/api/v1/orgs/:orgId/sites', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites`,
			headers: { ...asUser, 'idempotency-key': 'route-refused-0001' },
			json: { kind: 'drupal', name: 'route-refused-site' }
		});
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ code: 'unprocessable' });
		const details = (reply.json as { details: { operationId: string } }).details;
		const row = await env.DB.prepare('SELECT status FROM operations WHERE id = ?')
			.bind(details.operationId)
			.first<{ status: string }>();
		expect(row?.status).toBe('failed');
	});

	it('GET /sites/:id answers 404 for a ready site of another organisation', async () => {
		acceptingPort();
		const { siteId } = await createFor(OTHER_ORG, 'other-org-site');
		await markSiteReady(await getDb(), OTHER_ORG, siteId, 5_000);
		asMember();
		const reply = await send(siteRead, '/api/v1/sites/:id', {
			path: `/api/v1/sites/${siteId}`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
	});

	it("GET /sites pages the ready sites of the caller's organisation", async () => {
		acceptingPort();
		const org = 'org-list-paging';
		const ids: string[] = [];
		for (const name of ['list-one-site', 'list-two-site', 'list-three-site']) {
			const { siteId } = await createFor(org, name);
			await markSiteReady(await getDb(), org, siteId, 6_000);
			ids.push(siteId);
		}
		asMember(org);
		const first = await send(sitesList, '/api/v1/orgs/:orgId/sites', {
			path: `/api/v1/orgs/${org}/sites?limit=2`,
			headers: asUser
		});
		expect(first.status).toBe(200);
		const page = first.json as { items: { id: string }[]; nextCursor: string | null };
		expect(page.items.map((item) => item.id)).toEqual([...ids].sort().slice(0, 2));
		expect(page.nextCursor).not.toBeNull();
		const rest = await send(sitesList, '/api/v1/orgs/:orgId/sites', {
			path: `/api/v1/orgs/${org}/sites?limit=2&cursor=${page.nextCursor}`,
			headers: asUser
		});
		expect((rest.json as { items: unknown[] }).items).toHaveLength(1);
		expect((rest.json as { nextCursor: unknown }).nextCursor).toBeNull();
	});

	it('GET /sites refuses a cursor it did not issue', async () => {
		acceptingPort();
		asMember();
		const reply = await send(sitesList, '/api/v1/orgs/:orgId/sites', {
			path: `/api/v1/orgs/${ORG}/sites?cursor=%%%`,
			headers: asUser
		});
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('GET /sites/:id/operations lists the operations of a ready site', async () => {
		acceptingPort();
		const org = 'org-site-ops';
		const { siteId, stored } = await createFor(org, 'ops-listed-site');
		await markSiteReady(await getDb(), org, siteId, 7_000);
		asMember(org);
		const reply = await send(siteOperations, '/api/v1/sites/:id/operations', {
			path: `/api/v1/sites/${siteId}/operations`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		const items = (reply.json as { items: { id: string }[] }).items;
		expect(items.map((item) => item.id)).toEqual([stored.operation.id]);
	});

	it('GET /operations/:id returns the operation with its steps in order', async () => {
		acceptingPort();
		const org = 'org-op-read';
		const { stored } = await createFor(org, 'steps-read-site');
		const operationId = stored.operation.id;
		asMember(org);
		const reply = await send(operationRead, '/api/v1/orgs/:orgId/operations/:id', {
			path: `/api/v1/orgs/${org}/operations/${operationId}`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		const steps = (reply.json as { steps: { id: string; state: string }[] }).steps;
		expect(steps.slice(0, 2).map((step) => step.id)).toEqual(['lease', 'reserve-name']);
		expect(steps.at(-1)?.id).toBe('activate');
		expect(steps.every((step) => step.state === 'pending')).toBe(true);
		expect(steps.map((step) => step.id)).toEqual(stored.operation.steps.map((step) => step.id));
	});

	it('GET /orgs/:orgId/operations/:id answers 404 for an operation of another organisation', async () => {
		acceptingPort();
		const { stored } = await createFor(OTHER_ORG, 'other-op-site');
		asMember();
		const reply = await send(operationRead, '/api/v1/orgs/:orgId/operations/:id', {
			path: `/api/v1/orgs/${ORG}/operations/${stored.operation.id}`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
	});
});
