import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import siteDelete from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/delete.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getReadySite, markSiteReady, setSiteState } from '../../../src/server/db/repos/sites';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import {
	createSite,
	deleteSite,
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

const ROUTE = '/api/v1/orgs/:orgId/sites/:id/delete';

// the caller is an owner of ORG with a fresh sign-in; the site is read from the path like the real loader does
function asOwner(orgId = ORG) {
	setup({
		deps: {
			load: async (input) => ({
				resource: { orgId, departmentId: DEPT, siteId: input.params.id },
				facts: facts({ membership: { orgId, role: 'owner' }, ...fresh })
			})
		}
	});
}

const freeEntitlement = () => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

function acceptingPort() {
	const started: EngineStartRequest[] = [];
	setSiteServices({
		getDb,
		entitlements: { check: async () => ({ allow: true, entitlement: freeEntitlement() }) },
		startOperation: async (request) => {
			started.push(request);
		},
		config: {
			hostSuffix: 'drupflare.app',
			accountId: 'a'.repeat(32),
			releases: { drupal: 'v1.0.4' }
		}
	});
	return started;
}

let counter = 0;
const key = () => `key-${++counter}-${Date.now()}`;

// a ready site whose create has ended, so nothing holds it
async function readySite(orgId: string, name: string) {
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
	await env.DB.prepare('UPDATE sites SET account_id = ? WHERE id = ?')
		.bind('a'.repeat(32), siteId)
		.run();
	await markSiteReady(await getDb(), orgId, siteId, 5_000);
	return { siteId, createOperationId: stored.operation.id };
}

const remove = (
	siteId: string,
	options: { orgId?: string; confirm?: string; key?: string | null; headers?: object } = {}
): Promise<Reply> =>
	sendRequest(siteDelete, ROUTE, {
		method: 'POST',
		path: `/api/v1/orgs/${options.orgId ?? ORG}/sites/${siteId}/delete`,
		headers: {
			...(options.headers ?? asUser),
			...(options.key === null ? {} : { 'idempotency-key': options.key ?? key() })
		},
		json: { confirm: options.confirm ?? '' }
	});

const operationRows = async (siteId: string) =>
	(
		await env.DB.prepare(
			'SELECT id, type, status FROM operations WHERE site_id = ? ORDER BY created_at, rowid'
		)
			.bind(siteId)
			.all<{ id: string; type: string; status: string }>()
	).results;

describe('POST delete a site', () => {
	it('answers 202 with a site.delete operation and starts the workflow once with the hostnames', async () => {
		const started = acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-start-site');
		started.length = 0;
		asOwner();
		const reply = await remove(siteId, { confirm: 'delete-start-site' });
		expect(reply.status).toBe(202);
		const operation = reply.json as {
			id: string;
			type: string;
			status: string;
			targetIds: string[];
		};
		expect(operation).toMatchObject({
			type: 'site.delete',
			status: 'planned',
			verification: 'not-required',
			targetIds: [siteId]
		});
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			workflow: 'site-delete',
			id: operation.id,
			params: {
				operationId: operation.id,
				siteId,
				accountId: 'a'.repeat(32),
				hostnames: ['delete-start-site.drupflare.app']
			}
		});
		const site = await getReadySite(await getDb(), ORG, siteId);
		expect(site?.state).toBe('active');
	});

	it('answers 422 with a specific message when the name does not match, and starts nothing', async () => {
		const started = acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-mismatch-site');
		started.length = 0;
		asOwner();
		for (const confirm of [
			'',
			'delete-mismatch',
			'Delete-Mismatch-Site',
			'delete-mismatch-site '
		]) {
			const reply = await remove(siteId, { confirm });
			expect(reply.status, confirm).toBe(422);
			expect(reply.json).toMatchObject({
				code: 'unprocessable',
				message: 'The name you typed does not match this site',
				details: { reason: 'confirm_mismatch' }
			});
		}
		expect(started).toHaveLength(0);
		expect((await operationRows(siteId)).map((row) => row.type)).toEqual(['site.create']);
	});

	it('returns the same operation for a repeated key, from the route and from the service, and starts once', async () => {
		const started = acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-repeat-site');
		started.length = 0;
		asOwner();
		const repeated = key();
		const first = await remove(siteId, { confirm: 'delete-repeat-site', key: repeated });
		const second = await remove(siteId, { confirm: 'delete-repeat-site', key: repeated });
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect(second.json).toEqual(first.json);
		expect(started).toHaveLength(1);

		// the service answers a repeat by key even once the site no longer reads as live
		await env.DB.prepare('UPDATE operations SET status = ? WHERE site_id = ?')
			.bind('succeeded', siteId)
			.run();
		await setSiteState(await getDb(), ORG, siteId, 'tombstoned', 9_000);
		const again = await deleteSite(siteServices(), {
			orgId: ORG,
			siteId,
			confirm: 'delete-repeat-site',
			idempotencyKey: repeated
		});
		expect(again.operation.id).toBe((first.json as { id: string }).id);
		expect(started).toHaveLength(1);
	});

	it('refuses a key that already belongs to another request', async () => {
		acceptingPort();
		const first = await readySite(ORG, 'delete-reuse-one');
		const second = await readySite(ORG, 'delete-reuse-two');
		asOwner();
		const shared = key();
		expect(
			(await remove(first.siteId, { confirm: 'delete-reuse-one', key: shared })).status
		).toBe(202);
		const reply = await deleteSite(siteServices(), {
			orgId: ORG,
			siteId: second.siteId,
			confirm: 'delete-reuse-two',
			idempotencyKey: shared
		}).catch((caught: unknown) => caught);
		expect(reply).toBeInstanceOf(ApiError);
		expect(reply).toMatchObject({
			code: 'conflict',
			details: { reason: 'idempotency_key_reused' }
		});
	});

	it('answers 409 while another operation on the site is running, and 202 once it ends', async () => {
		const started = acceptingPort();
		const { siteId, createOperationId } = await readySite(ORG, 'delete-busy-site');
		started.length = 0;
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('running', createOperationId)
			.run();
		asOwner();
		const busy = await remove(siteId, { confirm: 'delete-busy-site' });
		expect(busy.status).toBe(409);
		expect(busy.json).toMatchObject({
			code: 'conflict',
			details: { reason: 'site_busy', operationId: createOperationId }
		});
		expect(started).toHaveLength(0);

		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('succeeded', createOperationId)
			.run();
		expect((await remove(siteId, { confirm: 'delete-busy-site' })).status).toBe(202);
	});

	it('answers 404 for a site of another organisation and writes nothing', async () => {
		const started = acceptingPort();
		const { siteId } = await readySite(OTHER_ORG, 'delete-foreign-site');
		started.length = 0;
		asOwner();
		const reply = await remove(siteId, { confirm: 'delete-foreign-site' });
		expect(reply.status).toBe(404);
		expect(reply.json).toMatchObject({ code: 'not_found' });
		expect(started).toHaveLength(0);
		expect((await operationRows(siteId)).map((row) => row.type)).toEqual(['site.create']);
	});

	it('refuses a key without site.delete, and one with it, since a key cannot carry the step-up', async () => {
		const started = acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-key-site');
		started.length = 0;
		for (const scopes of [['site.read'], ['site.delete']]) {
			setup({
				deps: {
					load: async (input) => ({
						resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
						facts: facts({
							membership: { orgId: ORG, role: 'owner' },
							...fresh,
							key: { id: 'key-1', scopes }
						})
					})
				}
			});
			const reply = await remove(siteId, { confirm: 'delete-key-site', headers: asKey });
			expect(reply.status, scopes.join()).toBe(403);
		}
		expect(started).toHaveLength(0);
		expect((await operationRows(siteId)).map((row) => row.type)).toEqual(['site.create']);
	});

	it('asks for a fresh sign-in when the session is stale', async () => {
		const started = acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-stale-site');
		started.length = 0;
		setup({
			deps: {
				load: async (input) => ({
					resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
					facts: facts({ membership: { orgId: ORG, role: 'owner' } })
				})
			}
		});
		const reply = await remove(siteId, { confirm: 'delete-stale-site' });
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(started).toHaveLength(0);
	});

	it('requires the Idempotency-Key header', async () => {
		acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-nokey-site');
		asOwner();
		const reply = await remove(siteId, { confirm: 'delete-nokey-site', key: null });
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('refuses a site that is already deleted', async () => {
		const started = acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-twice-site');
		started.length = 0;
		await setSiteState(await getDb(), ORG, siteId, 'tombstoned', 9_000);
		asOwner();
		const reply = await remove(siteId, { confirm: 'delete-twice-site' });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'site_not_live' } });
		expect(started).toHaveLength(0);
	});

	it('ends the operation as failed and leaves the site alone when the engine refuses the start', async () => {
		acceptingPort();
		const { siteId } = await readySite(ORG, 'delete-refused-site');
		setSiteServices({
			startOperation: async () => {
				throw new Error('signed request refused');
			}
		});
		asOwner();
		const reply = await remove(siteId, { confirm: 'delete-refused-site' });
		expect(reply.status).toBe(422);
		const rows = await operationRows(siteId);
		expect(rows.at(-1)).toMatchObject({ type: 'site.delete', status: 'failed' });
		expect((await getReadySite(await getDb(), ORG, siteId))?.state).toBe('active');
		// the failed delete does not hold the site
		setSiteServices({ startOperation: async () => undefined });
		expect((await remove(siteId, { confirm: 'delete-refused-site' })).status).toBe(202);
	});
});
