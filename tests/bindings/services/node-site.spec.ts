import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../../contracts/src/common';
import nodeSites from '../../../src/server/api/v1/orgs/[orgId]/nodes/[id]/sites.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { insertNode } from '../../../src/server/db/repos/nodes';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import { EngineStartError, type EngineStartRequest } from '../../../src/server/integrations/engine';
import { createNodeSite } from '../../../src/server/services/node-site';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import {
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { ApiError } from '../../../src/shared/errors';
import { ACTION_DEFS, isSessionOnly } from '../../../src/shared/permissions';
import { FakeNode } from '../../rigs/fake-node';
import { DEPT, ORG, OTHER_ORG, allowedSet, facts, fresh, member } from '../../unit/domain/fixtures';
import { asUser, send, setup } from '../../unit/server/fixtures/harness';
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

const ROUTE = '/api/v1/orgs/:orgId/nodes/:id/sites';
let counter = 0;
const key = () => `node-site-key-${++counter}-${Date.now()}`;

const entitlement = (nodes: number | null = 2) => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return { ...result.entitlement, nodes };
};

function install(options: { nodes?: number | null; release?: string; fail?: boolean } = {}) {
	const started: EngineStartRequest[] = [];
	installPendingSecrets(getDb);
	setSiteServices({
		getDb,
		entitlements: {
			check: async () => ({
				allow: true,
				entitlement: entitlement(options.nodes === undefined ? 2 : options.nodes)
			})
		},
		planOf: async () => entitlement(),
		startOperation: async (request) => {
			if (options.fail) throw new EngineStartError('engine_unavailable', 'engine is down');
			started.push(request);
		},
		config: {
			hostSuffix: 'drupflare.app',
			accountId: 'a'.repeat(32),
			releases: options.release === '' ? {} : { drupal: options.release ?? 'v1.0.5' }
		}
	});
	return { started };
}

async function box(orgId = ORG, lastSeenAt: number | null = Date.now() - 1000) {
	const fake = await FakeNode.create({ now: () => Date.now() });
	const id = newId('nod');
	const db = await getDb();
	await insertNode(db, {
		id,
		orgId,
		publicKey: fake.key.publicKey,
		hostFacts: fake.hostFacts,
		now: Date.now() - 60_000
	});
	if (lastSeenAt !== null) {
		await env.DB.prepare('UPDATE nodes SET last_seen_at = ? WHERE id = ?')
			.bind(lastSeenAt, id)
			.run();
	}
	return id;
}

const input = (nodeId: string, host = 'www.example.org', idempotencyKey = key()) => ({
	orgId: ORG,
	userId: 'user-bindings',
	nodeId,
	kind: 'drupal' as const,
	name: 'campus-site',
	host,
	idempotencyKey
});

const refusal = async (promise: Promise<unknown>) => {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(ApiError);
		return (error as ApiError).details as { reason?: string };
	}
	throw new Error('expected a refusal');
};

const siteRows = async (hostname: string) =>
	(
		await env.DB.prepare(
			'SELECT id, plane, state, node_id, ready_at, primary_hostname FROM sites WHERE primary_hostname = ?'
		)
			.bind(hostname)
			.all<{
				id: string;
				plane: string;
				state: string;
				node_id: string | null;
				ready_at: number | null;
			}>()
	).results;

describe('createNodeSite', () => {
	it('writes one hidden self-hosted site and one node.command operation, then starts the engine', async () => {
		const { started } = install();
		const nodeId = await box();
		const stored = await createNodeSite(siteServices(), input(nodeId, 'start.example.org'));
		expect(stored.operation).toMatchObject({ type: 'node.command', status: 'planned' });
		expect(stored.operation.steps.map((step) => step.id)).toEqual([
			'claim',
			'payload',
			'add',
			'wait',
			'activate'
		]);
		const [row] = await siteRows('start.example.org');
		expect(row).toMatchObject({ plane: 'self-hosted', ready_at: null, node_id: null });
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ workflow: 'node-site-create', id: stored.operation.id });
		expect(started[0]!.params).toMatchObject({
			nodeId,
			hostname: 'start.example.org',
			releaseId: 'v1.0.5',
			orgId: ORG
		});
		expect(JSON.stringify(started[0]!.params)).not.toMatch(/password|token|secret/i);
	});

	it('returns the same operation for a repeat key and refuses a key reused for another host', async () => {
		const { started } = install();
		const nodeId = await box();
		const idempotencyKey = key();
		const first = await createNodeSite(
			siteServices(),
			input(nodeId, 'repeat.example.org', idempotencyKey)
		);
		const again = await createNodeSite(
			siteServices(),
			input(nodeId, 'repeat.example.org', idempotencyKey)
		);
		expect(again.operation.id).toBe(first.operation.id);
		expect(started).toHaveLength(1);
		expect(await siteRows('repeat.example.org')).toHaveLength(1);
		expect(
			await refusal(
				createNodeSite(siteServices(), input(nodeId, 'other.example.org', idempotencyKey))
			)
		).toMatchObject({ reason: 'idempotency_key_reused' });
	});

	it.each([
		['a box that never connected', async () => box(ORG, null), 'node_offline'],
		['a box quiet for an hour', async () => box(ORG, Date.now() - 3_600_000), 'node_offline'],
		['a box of another organization', async () => box(OTHER_ORG), 'node_not_found'],
		['a box that does not exist', async () => newId('nod'), 'node_not_found']
	])('refuses %s', async (_label, make, reason) => {
		const { started } = install();
		const nodeId = await make();
		expect(
			await refusal(createNodeSite(siteServices(), input(nodeId, `${reason}.example.org`)))
		).toMatchObject({ reason });
		expect(started).toEqual([]);
		expect(await siteRows(`${reason}.example.org`)).toEqual([]);
	});

	it('refuses a revoked box', async () => {
		install();
		const nodeId = await box();
		await env.DB.prepare("UPDATE nodes SET state = 'revoked', revoked_at = ? WHERE id = ?")
			.bind(Date.now(), nodeId)
			.run();
		expect(
			await refusal(createNodeSite(siteServices(), input(nodeId, 'revoked.example.org')))
		).toMatchObject({ reason: 'node_revoked' });
	});

	it('refuses a plan with no nodes, a missing release, a platform address and a bad host', async () => {
		const nodeId = await box();
		install({ nodes: 0 });
		expect(
			await refusal(createNodeSite(siteServices(), input(nodeId, 'plan.example.org')))
		).toMatchObject({ reason: 'plan_no_nodes' });
		install({ release: '' });
		expect(
			await refusal(createNodeSite(siteServices(), input(nodeId, 'release.example.org')))
		).toMatchObject({ reason: 'no_release' });
		install();
		expect(
			await refusal(createNodeSite(siteServices(), input(nodeId, 'a.drupflare.app')))
		).toMatchObject({ reason: 'platform_zone' });
		expect(
			await refusal(createNodeSite(siteServices(), input(nodeId, 'not a host')))
		).toMatchObject({ reason: 'invalid' });
	});

	it('retires the rows when the engine does not take the start', async () => {
		install({ fail: true });
		const nodeId = await box();
		await expect(
			createNodeSite(siteServices(), input(nodeId, 'engine-down.example.org'))
		).rejects.toBeInstanceOf(ApiError);
		const rows = await siteRows('engine-down.example.org');
		expect(rows).toHaveLength(1);
		expect(rows[0]!.state).toBe('deleted');
		const operation = await env.DB.prepare('SELECT status FROM operations WHERE site_id = ?')
			.bind(rows[0]!.id)
			.first<{ status: string }>();
		expect(operation?.status).toBe('failed');
	});

	it('lets a new create take an address a stranded unready row holds', async () => {
		const { started } = install();
		const nodeId = await box();
		const stranded = await createNodeSite(siteServices(), input(nodeId, 'again.example.org'));
		await env.DB.prepare("UPDATE operations SET status = 'failed' WHERE id = ?")
			.bind(stranded.operation.id)
			.run();
		await env.DB.prepare(
			`INSERT OR REPLACE INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
			provider_id, ownership_epoch, created_at, updated_at)
			VALUES ('again.example.org', ?, ?, ?, 1, 'claimed', NULL, NULL, 1, 1)`
		)
			.bind(ORG, stranded.operation.targetIds[0], stranded.operation.id)
			.run();
		const next = await createNodeSite(siteServices(), input(nodeId, 'again.example.org'));
		expect(next.operation.id).not.toBe(stranded.operation.id);
		expect(started).toHaveLength(2);
	});

	it('refuses an address a live site of the organization already holds, found on a box or not', async () => {
		const { started } = install();
		const nodeId = await box();
		await env.DB.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, node_id,
				box_found_as, ready_at, created_at, updated_at)
			 VALUES ('site_foundlive01', ?, 'found-live', 'self-hosted', 'active', 'found.example.org', ?,
				'found.example.org', 1, 1, 1)`
		)
			.bind(ORG, nodeId)
			.run();
		expect(
			await refusal(createNodeSite(siteServices(), input(nodeId, 'Found.Example.org')))
		).toEqual({
			reason: 'host_taken'
		});
		await env.DB.prepare(
			"UPDATE sites SET state = 'deleted' WHERE id = 'site_foundlive01'"
		).run();
		await createNodeSite(siteServices(), input(nodeId, 'found.example.org'));
		expect(started).toHaveLength(1);
	});
});

describe('POST /api/v1/orgs/:orgId/nodes/:id/sites', () => {
	function asRole(role: 'owner' | 'admin' | 'developer' | 'viewer') {
		setup({
			deps: {
				load: async (input) => ({
					resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
					facts: facts({ membership: { orgId: ORG, role }, ...fresh })
				})
			}
		});
	}
	const post = (nodeId: string, json: unknown, headers: Record<string, string> = asUser) =>
		send(nodeSites, ROUTE, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/nodes/${nodeId}/sites`,
			headers: { ...headers, 'idempotency-key': key() },
			json
		});

	it('gives owners and admins the action without a step-up, and no one below them', () => {
		expect(ACTION_DEFS['node.site.create'].org).toEqual(['owner', 'admin']);
		expect(ACTION_DEFS['node.site.create']).not.toHaveProperty('stepUp');
		expect(isSessionOnly('node.site.create')).toBe(false);
		const allowed = ['owner', 'admin', 'developer', 'viewer'].filter(
			(role) =>
				allowedSet(['node.site.create'], facts({ ...member(role as 'owner'), ...fresh }))
					.length > 0
		);
		expect(allowed).toEqual(['owner', 'admin']);
	});

	it('answers 403 to a developer and a viewer before anything is written', async () => {
		install();
		const nodeId = await box();
		for (const role of ['viewer', 'developer'] as const) {
			asRole(role);
			const reply = await post(nodeId, {
				kind: 'drupal',
				name: 'roles-site',
				host: 'roles.example.org'
			});
			expect(reply.status).toBe(403);
		}
		expect(await siteRows('roles.example.org')).toEqual([]);
	});

	it('answers 202 with the operation for an admin and 422 with the reason for a refusal', async () => {
		install();
		const nodeId = await box();
		asRole('admin');
		const ok = await post(nodeId, {
			kind: 'drupal',
			name: 'route-site',
			host: 'route.example.org'
		});
		expect(ok.status).toBe(202);
		expect(ok.json).toMatchObject({ type: 'node.command' });
		const quiet = await box(ORG, null);
		const refused = await post(quiet, {
			kind: 'drupal',
			name: 'quiet-site',
			host: 'quiet.example.org'
		});
		expect(refused.status).toBe(422);
		expect(refused.json).toMatchObject({ details: { reason: 'node_offline' } });
	});

	it('answers 400 to a body with an unknown field and 404 for a box of another organization', async () => {
		install();
		const nodeId = await box();
		asRole('owner');
		const extra = await post(nodeId, {
			kind: 'drupal',
			name: 'x',
			host: 'x.example.org',
			tenant: 'main'
		});
		expect(extra.status).toBe(400);
		const foreign = await box(OTHER_ORG);
		const missing = await post(foreign, { kind: 'drupal', name: 'x', host: 'y.example.org' });
		expect(missing.status).toBe(404);
	});
});
