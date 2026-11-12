import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import siteAdopt from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/adopt.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	countOrganizationSites,
	getReadySite,
	markSiteReady
} from '../../../src/server/db/repos/sites';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import { adoptSite } from '../../../src/server/services/site-adopt';
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
	asKey,
	asUser,
	send as sendRequest,
	setup,
	type Reply
} from '../../unit/server/fixtures/harness';
import { installPendingSecrets, openBindings, type Bindings, type OpenBindings } from '../support';

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
	resetPendingSecretDeps();
	resetApiDeps();
});

const ROUTE = '/api/v1/orgs/:orgId/sites/:id/adopt';
const CUSTOMER_ACCOUNT = 'c'.repeat(32);

function asRole(role: 'owner' | 'viewer', options: { stepUp?: boolean } = {}) {
	setup({
		deps: {
			load: async (input) => ({
				resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
				facts: facts({
					membership: { orgId: ORG, role },
					...(options.stepUp === false ? {} : fresh)
				})
			})
		}
	});
}

const freeEntitlement = () => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

function acceptingPort(allow = true) {
	const started: EngineStartRequest[] = [];
	installPendingSecrets(getDb);
	setSiteServices({
		getDb,
		entitlements: {
			check: async () =>
				allow
					? { allow: true, entitlement: freeEntitlement() }
					: { allow: false, reason: 'site_limit' }
		},
		planOf: async () => freeEntitlement(),
		startOperation: async (request) => {
			started.push(request);
		},
		config: {
			hostSuffix: 'drupflare.app',
			accountId: 'a'.repeat(32),
			releases: { drupal: 'v1.0.5' }
		}
	});
	return started;
}

let counter = 0;
const key = () => `adopt-key-${++counter}-${Date.now()}`;

// a live site on the self-managed plane, in the customer's own account
async function selfManaged(orgId: string, name: string, plane = 'self-managed') {
	const stored = await createSite(siteServices(), {
		orgId,
		userId: 'user-bindings',
		kind: 'drupal',
		name,
		hostnameLabel: undefined,
		idempotencyKey: key()
	});
	const siteId = stored.operation.targetIds[0] as string;
	await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
		.bind('succeeded', stored.operation.id)
		.run();
	await env.DB.prepare(
		'UPDATE sites SET account_id = ?, plane = ?, primary_hostname = ? WHERE id = ?'
	)
		.bind(CUSTOMER_ACCOUNT, plane, `${name}.example.test`, siteId)
		.run();
	await markSiteReady(await getDb(), orgId, siteId, 5_000);
	return { siteId, createOperationId: stored.operation.id };
}

const adopt = (
	siteId: string,
	options: { key?: string | null; headers?: Record<string, string> } = {}
): Promise<Reply> =>
	sendRequest(siteAdopt, ROUTE, {
		method: 'POST',
		path: `/api/v1/orgs/${ORG}/sites/${siteId}/adopt`,
		headers: {
			...(options.headers ?? asUser),
			...(options.key === null ? {} : { 'idempotency-key': options.key ?? key() })
		}
	});

const operationRows = async (siteId: string) =>
	(
		await env.DB.prepare(
			'SELECT id, type, status FROM operations WHERE site_id = ? ORDER BY created_at, rowid'
		)
			.bind(siteId)
			.all<{ id: string; type: string; status: string }>()
	).results;

describe('POST an adoption', () => {
	it('answers 202 with a site.adopt operation, writes a hidden managed site and starts the workflow once', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-start-site');
		started.length = 0;
		asRole('owner');
		const reply = await adopt(siteId);
		expect(reply.status).toBe(202);
		const operation = reply.json as {
			id: string;
			type: string;
			status: string;
			targetIds: string[];
		};
		expect(operation).toMatchObject({ type: 'site.adopt', status: 'planned' });
		const [targetId, sourceId] = operation.targetIds;
		expect(sourceId).toBe(siteId);
		expect(targetId).not.toBe(siteId);

		expect(started).toHaveLength(1);
		const params = started[0]!.params as {
			source: { id: string; accountId: string };
			create: {
				site: { id: string; plane: string; accountId: string; kind: string };
				firstRun: { reads: Record<string, string> };
				hostname: string;
			};
		};
		expect(started[0]).toMatchObject({ workflow: 'site-adopt', id: operation.id });
		expect(params.source).toEqual({ id: siteId, accountId: CUSTOMER_ACCOUNT });
		expect(params.create.site).toMatchObject({
			id: targetId,
			plane: 'managed',
			kind: 'drupal',
			accountId: 'a'.repeat(32)
		});
		expect(params.create.firstRun.reads).toEqual({ ownerToken: expect.any(String) });
		expect(params.create.hostname.endsWith('.drupflare.app')).toBe(true);

		// the copy is hidden until the engine activates it, and the operation sits on the source
		expect(await getReadySite(await getDb(), ORG, targetId!)).toBeNull();
		expect((await operationRows(siteId)).map((row) => row.type)).toEqual([
			'site.create',
			'site.adopt'
		]);
	});

	it('returns the same operation for a repeated key and starts once', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-repeat-site');
		started.length = 0;
		asRole('owner');
		const repeated = key();
		const first = await adopt(siteId, { key: repeated });
		const second = await adopt(siteId, { key: repeated });
		expect(second.status).toBe(202);
		expect(second.json).toEqual(first.json);
		expect(started).toHaveLength(1);
	});

	it('refuses a key that already belongs to another request', async () => {
		acceptingPort();
		const one = await selfManaged(ORG, 'adopt-reuse-one');
		const two = await selfManaged(ORG, 'adopt-reuse-two');
		asRole('owner');
		const shared = key();
		expect((await adopt(one.siteId, { key: shared })).status).toBe(202);
		const caught = await adoptSite(siteServices(), {
			orgId: ORG,
			siteId: two.siteId,
			userId: 'user-bindings',
			idempotencyKey: shared
		}).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(ApiError);
		expect(caught).toMatchObject({
			code: 'conflict',
			details: { reason: 'idempotency_key_reused' }
		});
	});

	it('answers 422 for a site that is not self-managed', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-managed-site', 'managed');
		started.length = 0;
		asRole('owner');
		const reply = await adopt(siteId);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'not_self_managed' } });
		expect(started).toHaveLength(0);
	});

	it('answers 422 for a site that is not live', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-tombstoned-site');
		started.length = 0;
		await env.DB.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.bind('tombstoned', siteId)
			.run();
		asRole('owner');
		const reply = await adopt(siteId);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'site_not_live' } });
		expect(started).toHaveLength(0);
	});

	it('answers 409 for a site that was already adopted', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-twice-site');
		started.length = 0;
		await env.DB.prepare('UPDATE sites SET adopted_to = ? WHERE id = ?')
			.bind('site_elsewhere', siteId)
			.run();
		asRole('owner');
		const reply = await adopt(siteId);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'already_adopted' } });
		expect(started).toHaveLength(0);
	});

	it('answers 409 while another operation on the site is running, and holds the site once started', async () => {
		const started = acceptingPort();
		const { siteId, createOperationId } = await selfManaged(ORG, 'adopt-busy-site');
		started.length = 0;
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('running', createOperationId)
			.run();
		asRole('owner');
		const busy = await adopt(siteId);
		expect(busy.status).toBe(409);
		expect(busy.json).toMatchObject({ details: { reason: 'site_busy' } });
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('succeeded', createOperationId)
			.run();
		expect((await adopt(siteId)).status).toBe(202);
		expect((await adopt(siteId)).status).toBe(409);
		expect(started).toHaveLength(1);
	});

	it('answers 403 plan_full when the plan has no room, and writes nothing', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-full-site');
		started.length = 0;
		acceptingPort(false);
		asRole('owner');
		const reply = await adopt(siteId);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			details: { reason: 'plan_full', requires: 'entitlement' }
		});
		expect((await operationRows(siteId)).map((row) => row.type)).toEqual(['site.create']);
	});

	it('counts the copy against the plan while the adoption runs', async () => {
		acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-count-site');
		const before = await countOrganizationSites(await getDb(), ORG);
		asRole('owner');
		expect((await adopt(siteId)).status).toBe(202);
		expect(await countOrganizationSites(await getDb(), ORG)).toBe(before + 1);
	});

	it('answers 404 for a site of another organisation', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(OTHER_ORG, 'adopt-foreign-site');
		started.length = 0;
		asRole('owner');
		expect((await adopt(siteId)).status).toBe(404);
		expect(started).toHaveLength(0);
	});

	it('answers 501 when the platform has no release for the kind', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-norelease-site');
		started.length = 0;
		setSiteServices({
			config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases: {} }
		});
		asRole('owner');
		expect((await adopt(siteId)).status).toBe(501);
		expect(started).toHaveLength(0);
	});

	it('requires the Idempotency-Key header', async () => {
		acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-nokey-site');
		asRole('owner');
		const reply = await adopt(siteId, { key: null });
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('refuses a viewer', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-viewer-site');
		started.length = 0;
		asRole('viewer');
		expect((await adopt(siteId)).status).toBe(403);
		expect(started).toHaveLength(0);
	});

	it('refuses an API key as session only', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-key-site');
		started.length = 0;
		asRole('owner');
		const reply = await adopt(siteId, { headers: asKey });
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ code: 'forbidden' });
		expect(started).toHaveLength(0);
	});

	it('asks for a step-up and starts nothing without one', async () => {
		const started = acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-stepup-site');
		started.length = 0;
		asRole('owner', { stepUp: false });
		const reply = await adopt(siteId);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(started).toHaveLength(0);
	});

	it('ends the operation as failed and drops the hidden copy when the engine refuses the start', async () => {
		acceptingPort();
		const { siteId } = await selfManaged(ORG, 'adopt-refused-site');
		let target = '';
		setSiteServices({
			startOperation: async (request) => {
				target = (request.params as { create: { site: { id: string } } }).create.site.id;
				throw new Error('signed request refused');
			}
		});
		asRole('owner');
		const reply = await adopt(siteId);
		expect(reply.status).toBe(422);
		expect((await operationRows(siteId)).at(-1)).toMatchObject({
			type: 'site.adopt',
			status: 'failed'
		});
		const row = await env.DB.prepare('SELECT state FROM sites WHERE id = ?')
			.bind(target)
			.first<{ state: string }>();
		expect(row?.state).toBe('deleted');
		setSiteServices({ startOperation: async () => undefined });
		expect((await adopt(siteId)).status).toBe(202);
	});
});
