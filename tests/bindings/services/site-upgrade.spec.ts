import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import siteUpgrade from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/upgrade.post';
import siteRead from '../../../src/server/api/v1/sites/[id]/index.get';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { markSiteReady, setSiteState } from '../../../src/server/db/repos/sites';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import {
	createSite,
	resetSiteServices,
	setSiteServices,
	siteServices,
	upgradeSite
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { ApiError } from '../../../src/shared/errors';
import { DEPT, ORG, OTHER_ORG, facts, fresh } from '../../unit/domain/fixtures';
import { asUser, send as sendRequest, setup, type Reply } from '../../unit/server/fixtures/harness';
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

const ROUTE = '/api/v1/orgs/:orgId/sites/:id/upgrade';

function asRole(role: 'owner' | 'viewer', orgId = ORG) {
	setup({
		deps: {
			load: async (input) => ({
				resource: { orgId, departmentId: DEPT, siteId: input.params.id },
				facts: facts({ membership: { orgId, role }, ...fresh })
			})
		}
	});
}

const freeEntitlement = () => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

function acceptingPort(releases: Record<string, string> = { drupal: 'v1.0.5' }) {
	const started: EngineStartRequest[] = [];
	installPendingSecrets(getDb);
	setSiteServices({
		getDb,
		entitlements: { check: async () => ({ allow: true, entitlement: freeEntitlement() }) },
		planOf: async () => freeEntitlement(),
		startOperation: async (request) => {
			started.push(request);
		},
		config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases }
	});
	return started;
}

let counter = 0;
const key = () => `up-key-${++counter}-${Date.now()}`;

// a ready site whose create has ended on release v1.0.4, so nothing holds it
async function liveSite(orgId: string, name: string, release: string | null = 'v1.0.4') {
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
	await env.DB.prepare('UPDATE sites SET account_id = ?, release_id = ? WHERE id = ?')
		.bind('a'.repeat(32), release, siteId)
		.run();
	await markSiteReady(await getDb(), orgId, siteId, 5_000);
	return { siteId, createOperationId: stored.operation.id };
}

const upgrade = (
	siteId: string,
	options: { orgId?: string; key?: string | null } = {}
): Promise<Reply> =>
	sendRequest(siteUpgrade, ROUTE, {
		method: 'POST',
		path: `/api/v1/orgs/${options.orgId ?? ORG}/sites/${siteId}/upgrade`,
		headers: {
			...asUser,
			...(options.key === null ? {} : { 'idempotency-key': options.key ?? key() })
		}
	});

const read = (siteId: string): Promise<Reply> =>
	sendRequest(siteRead, '/api/v1/sites/:id', {
		method: 'GET',
		path: `/api/v1/sites/${siteId}`,
		headers: asUser
	});

const operationRows = async (siteId: string) =>
	(
		await env.DB.prepare(
			'SELECT id, type, status FROM operations WHERE site_id = ? ORDER BY created_at, rowid'
		)
			.bind(siteId)
			.all<{ id: string; type: string; status: string }>()
	).results;

describe('the release on a site read', () => {
	it('gives the recorded release and the one the platform offers', async () => {
		acceptingPort();
		const { siteId } = await liveSite(ORG, 'read-release-site');
		asRole('owner');
		const reply = await read(siteId);
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ release: { current: 'v1.0.4', available: 'v1.0.5' } });
	});

	it('gives null for a site made before releases were recorded', async () => {
		acceptingPort();
		const { siteId } = await liveSite(ORG, 'read-unrecorded-site', null);
		asRole('owner');
		expect((await read(siteId)).json).toMatchObject({
			release: { current: null, available: 'v1.0.5' }
		});
	});

	it('gives a null available release when none is configured for the kind', async () => {
		acceptingPort();
		const { siteId } = await liveSite(ORG, 'read-nothing-site');
		setSiteServices({
			config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases: {} }
		});
		asRole('owner');
		expect((await read(siteId)).json).toMatchObject({
			release: { current: 'v1.0.4', available: null }
		});
	});
});

describe('POST an update', () => {
	it('answers 202 with a site.upgrade operation and starts the workflow once with the target', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-start-site');
		started.length = 0;
		asRole('owner');
		const reply = await upgrade(siteId);
		expect(reply.status).toBe(202);
		const operation = reply.json as {
			id: string;
			type: string;
			status: string;
			targetIds: string[];
		};
		expect(operation).toMatchObject({
			type: 'site.upgrade',
			status: 'planned',
			targetIds: [siteId]
		});
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			workflow: 'site-upgrade',
			id: operation.id,
			params: {
				operationId: operation.id,
				releaseId: 'v1.0.5',
				currentRelease: 'v1.0.4',
				hostname: 'upgrade-start-site.drupflare.app',
				site: {
					id: siteId,
					plane: 'managed',
					plan: FREE_PLAN_ID,
					accountId: 'a'.repeat(32)
				},
				probe: { path: '/health', expectStatus: 200, auth: 'owner-token' }
			}
		});
	});

	it('starts a site with no recorded release, which is never up to date', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-unrecorded-site', null);
		started.length = 0;
		asRole('owner');
		expect((await upgrade(siteId)).status).toBe(202);
		expect(started[0]?.params).toMatchObject({ releaseId: 'v1.0.5', currentRelease: null });
	});

	it('returns the same operation for a repeated key and starts once', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-repeat-site');
		started.length = 0;
		asRole('owner');
		const repeated = key();
		const first = await upgrade(siteId, { key: repeated });
		const second = await upgrade(siteId, { key: repeated });
		expect(first.status).toBe(202);
		expect(second.status).toBe(202);
		expect(second.json).toEqual(first.json);
		expect(started).toHaveLength(1);

		// the service answers a repeat by key while the first is still running and after it ended
		await env.DB.prepare('UPDATE operations SET status = ? WHERE site_id = ?')
			.bind('succeeded', siteId)
			.run();
		await env.DB.prepare('UPDATE sites SET release_id = ? WHERE id = ?')
			.bind('v1.0.5', siteId)
			.run();
		const again = await upgradeSite(siteServices(), {
			orgId: ORG,
			siteId,
			idempotencyKey: repeated
		});
		expect(again.operation.id).toBe((first.json as { id: string }).id);
		expect(started).toHaveLength(1);
	});

	it('refuses a key that already belongs to another request', async () => {
		acceptingPort();
		const first = await liveSite(ORG, 'upgrade-reuse-one');
		const second = await liveSite(ORG, 'upgrade-reuse-two');
		asRole('owner');
		const shared = key();
		expect((await upgrade(first.siteId, { key: shared })).status).toBe(202);
		const caught = await upgradeSite(siteServices(), {
			orgId: ORG,
			siteId: second.siteId,
			idempotencyKey: shared
		}).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(ApiError);
		expect(caught).toMatchObject({
			code: 'conflict',
			details: { reason: 'idempotency_key_reused' }
		});
	});

	it('answers 409 up_to_date when the site runs the current release, and starts nothing', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-current-site', 'v1.0.5');
		started.length = 0;
		asRole('owner');
		const reply = await upgrade(siteId);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({
			code: 'conflict',
			details: { reason: 'up_to_date', release: 'v1.0.5' }
		});
		expect(started).toHaveLength(0);
		expect((await operationRows(siteId)).map((row) => row.type)).toEqual(['site.create']);
	});

	it('answers 409 while another operation on the site is running, and 202 once it ends', async () => {
		const started = acceptingPort();
		const { siteId, createOperationId } = await liveSite(ORG, 'upgrade-busy-site');
		started.length = 0;
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('running', createOperationId)
			.run();
		asRole('owner');
		const busy = await upgrade(siteId);
		expect(busy.status).toBe(409);
		expect(busy.json).toMatchObject({
			code: 'conflict',
			details: { reason: 'site_busy', operationId: createOperationId }
		});
		expect(started).toHaveLength(0);

		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('succeeded', createOperationId)
			.run();
		expect((await upgrade(siteId)).status).toBe(202);
		// the update just started holds the site against a second one
		expect((await upgrade(siteId)).status).toBe(409);
	});

	it('answers 404 for a site of another organisation and writes nothing', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(OTHER_ORG, 'upgrade-foreign-site');
		started.length = 0;
		asRole('owner');
		const reply = await upgrade(siteId);
		expect(reply.status).toBe(404);
		expect(started).toHaveLength(0);
		expect((await operationRows(siteId)).map((row) => row.type)).toEqual(['site.create']);
	});

	it('answers 422 for a site that is not live', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-tombstoned-site');
		started.length = 0;
		await setSiteState(await getDb(), ORG, siteId, 'tombstoned', 9_000);
		asRole('owner');
		const reply = await upgrade(siteId);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'site_not_live' } });
		expect(started).toHaveLength(0);
	});

	it('answers 501 when the platform has no current release for the kind', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-norelease-site');
		started.length = 0;
		setSiteServices({
			config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases: {} }
		});
		asRole('owner');
		const reply = await upgrade(siteId);
		expect(reply.status).toBe(501);
		expect(started).toHaveLength(0);
	});

	it('requires the Idempotency-Key header', async () => {
		acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-nokey-site');
		asRole('owner');
		const reply = await upgrade(siteId, { key: null });
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});

	it('refuses a viewer', async () => {
		const started = acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-viewer-site');
		started.length = 0;
		asRole('viewer');
		expect((await upgrade(siteId)).status).toBe(403);
		expect(started).toHaveLength(0);
	});

	it('ends the operation as failed and leaves the site alone when the engine refuses the start', async () => {
		acceptingPort();
		const { siteId } = await liveSite(ORG, 'upgrade-refused-site');
		setSiteServices({
			startOperation: async () => {
				throw new Error('signed request refused');
			}
		});
		asRole('owner');
		const reply = await upgrade(siteId);
		expect(reply.status).toBe(422);
		expect((await operationRows(siteId)).at(-1)).toMatchObject({
			type: 'site.upgrade',
			status: 'failed'
		});
		// the failed update does not hold the site
		setSiteServices({ startOperation: async () => undefined });
		expect((await upgrade(siteId)).status).toBe(202);
	});
});
