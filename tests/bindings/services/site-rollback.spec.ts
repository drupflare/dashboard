import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import siteRollback from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/rollback.post';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { registerRelease } from '../../../src/server/db/repos/releases';
import { markSiteReady } from '../../../src/server/db/repos/sites';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import {
	createSite,
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { DEPT, ORG, facts, fresh } from '../../unit/domain/fixtures';
import { asUser, send as sendRequest, setup, type Reply } from '../../unit/server/fixtures/harness';
import { installPendingSecrets, openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));
const ROUTE = '/api/v1/orgs/:orgId/sites/:id/rollback';
const digest = `sha256:${'1'.repeat(64)}`;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	const base = { manifestDigest: digest, publishedAt: 1, now: 1 };
	const db = await getDb();
	await registerRelease(db, {
		...base,
		id: 'v1.0.4',
		kind: 'worker',
		version: '1.0.4',
		schemaVersion: 1,
		acceptsSchema: 1
	});
	await registerRelease(db, {
		...base,
		id: 'v1.0.5',
		kind: 'worker',
		version: '1.0.5',
		schemaVersion: 2,
		acceptsSchema: 1
	});
});

afterAll(() => harness.close());

afterEach(() => {
	resetSiteServices();
	resetPendingSecretDeps();
	resetApiDeps();
});

function asRole(role: 'owner' | 'viewer') {
	setup({
		deps: {
			load: async (input) => ({
				resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
				facts: facts({ membership: { orgId: ORG, role }, ...fresh })
			})
		}
	});
}

function port() {
	const started: EngineStartRequest[] = [];
	installPendingSecrets(getDb);
	const entitlement = derive(FREE_PLAN_ID);
	if (!entitlement.ok) throw new Error(entitlement.reason);
	setSiteServices({
		getDb,
		entitlements: {
			check: async () => ({ allow: true, entitlement: entitlement.entitlement })
		},
		planOf: async () => entitlement.entitlement,
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

const rollbacks = (started: EngineStartRequest[]) =>
	started.filter((request) => request.workflow === 'site-rollback');

let counter = 0;
const key = () => `rb-key-${++counter}-${Date.now()}`;

async function liveSite(name: string, dataSchema: number | null, release = 'v1.0.5') {
	const stored = await createSite(siteServices(), {
		orgId: ORG,
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
		'UPDATE sites SET account_id = ?, release_id = ?, data_schema_version = ? WHERE id = ?'
	)
		.bind('a'.repeat(32), release, dataSchema, siteId)
		.run();
	await markSiteReady(await getDb(), ORG, siteId, 5_000);
	return siteId;
}

const rollback = (
	siteId: string,
	body: unknown = { release: 'v1.0.4' },
	options: { key?: string | null } = {}
): Promise<Reply> =>
	sendRequest(siteRollback, ROUTE, {
		method: 'POST',
		path: `/api/v1/orgs/${ORG}/sites/${siteId}/rollback`,
		headers: {
			...asUser,
			...(options.key === null ? {} : { 'idempotency-key': options.key ?? key() })
		},
		json: body
	});

describe('POST a rollback', () => {
	it('answers 202 with a site.rollback operation and starts the workflow with the target', async () => {
		const started = port();
		const siteId = await liveSite('rollback-start-site', 1);
		asRole('owner');
		const reply = await rollback(siteId);
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({ type: 'site.rollback', targetIds: [siteId] });
		expect(rollbacks(started)).toHaveLength(1);
		expect(rollbacks(started)[0]).toMatchObject({
			workflow: 'site-rollback',
			params: { releaseId: 'v1.0.4', currentRelease: 'v1.0.5' }
		});
	});

	it('refuses with the reason and both offers when the data is past what the earlier code reads, and starts nothing', async () => {
		const started = port();
		const siteId = await liveSite('rollback-refused-site', 2);
		asRole('owner');
		const reply = await rollback(siteId);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({
			details: {
				reason: 'rollback_refused',
				offers: ['restore-data-with-code', 'fix-forward']
			}
		});
		expect(rollbacks(started)).toEqual([]);
	});

	it('refuses a site whose data version is unknown', async () => {
		const started = port();
		asRole('owner');
		const reply = await rollback(await liveSite('rollback-unknown-site', null));
		expect(reply.status).toBe(422);
		expect(rollbacks(started)).toEqual([]);
	});

	it('returns the same operation for a repeated key and starts once', async () => {
		const started = port();
		const siteId = await liveSite('rollback-repeat-site', 1);
		asRole('owner');
		const repeated = key();
		const first = await rollback(siteId, undefined, { key: repeated });
		const second = await rollback(siteId, undefined, { key: repeated });
		expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
		expect(rollbacks(started)).toHaveLength(1);
	});

	it('answers 409 when the site already runs that release', async () => {
		port();
		asRole('owner');
		const reply = await rollback(await liveSite('rollback-same-site', 1, 'v1.0.4'));
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'up_to_date' } });
	});

	it('answers 404 for a release that is not registered', async () => {
		port();
		asRole('owner');
		const reply = await rollback(await liveSite('rollback-nope-site', 1), {
			release: 'v0.0.1'
		});
		expect(reply.status).toBe(404);
	});

	it('needs an Idempotency-Key and a release in the body', async () => {
		port();
		asRole('owner');
		const siteId = await liveSite('rollback-input-site', 1);
		expect((await rollback(siteId, undefined, { key: null })).status).toBe(400);
		expect((await rollback(siteId, {})).status).toBe(400);
	});

	it('refuses a viewer', async () => {
		port();
		const siteId = await liveSite('rollback-viewer-site', 1);
		asRole('viewer');
		expect((await rollback(siteId)).status).toBe(403);
	});
});
