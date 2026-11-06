import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import { verifyStart } from '../../../contracts/src/engine-start';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest } from '../../../contracts/src/operations';
import { custodyOf } from '../../../engine/src/adapters/custody';
import { D1OperationStore } from '../../../engine/src/operations/store';
import { D1ResourceLedger } from '../../../engine/src/ownership';
import type { EngineDeps } from '../../../engine/src/ports';
import { handleStart, type WorkflowStarter } from '../../../engine/src/start';
import type { Outcome } from '../../../engine/src/workflows/common';
import {
	planSiteCreate,
	runSiteCreate,
	type SiteCreateInput
} from '../../../engine/src/workflows/site-create';
import reveal from '../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/first-run-secret.post';
import sitesCreate from '../../../src/server/api/v1/orgs/[orgId]/sites/index.post';
import siteRead from '../../../src/server/api/v1/sites/[id]/index.get';
import { ensurePersonalOrganization } from '../../../src/server/db/repos/accounts';
import { createSiteOperation } from '../../../src/server/db/repos/operations';
import { addMember, createOrganization } from '../../../src/server/db/repos/organization';
import { getReadySite } from '../../../src/server/db/repos/sites';
import { engineStarter, type EngineBinding } from '../../../src/server/integrations/engine';
import { buildServices, type BootEnv, type BuiltServices } from '../../../src/server/services/boot';
import {
	resetPendingSecretDeps,
	setPendingSecretDeps
} from '../../../src/server/services/owner-tokens';
import {
	collegeBudgets,
	createSite,
	resetSiteServices,
	setSiteServices
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { facts, fresh } from '../../unit/domain/fixtures';
import {
	FAKE_ADMIN_PASSWORD,
	PENDING_TTL_MS,
	fakeNames,
	makeRunner,
	makeWorld
} from '../../unit/engine/fakes';
import {
	asOtherUser,
	asUser,
	send as sendRequest,
	setup,
	type Reply
} from '../../unit/server/fixtures/harness';
import { openBindings, type Bindings, type OpenBindings } from '../support';

const START_SECRET = 'wiring-start-secret'.padEnd(40, 'x');
const KEK = toBase64Url(new Uint8Array(32).fill(7));
const ACCOUNT = 'c'.repeat(32);
const SITES_PATH = '/api/v1/orgs/:orgId/sites';

let open: OpenBindings;
let env: Bindings;
let built: BuiltServices;
let db: CollegeDBClient;

// the engine side: the engine's own start handler, its own create over fakes, and the real D1 for
// the operation store, the resource ledger and custody
const sharedNames = fakeNames(Date.now);
const instances = new Set<string>();
const outcomes = new Map<string, Outcome>();
const seen: { headers: Headers; body: string }[] = [];

// one Cloudflare account for every create, as in production: provider ids never repeat in it
let account: EngineDeps['cloudflare'] | undefined;

async function engineDeps(): Promise<EngineDeps> {
	const world = await makeWorld();
	world.clock.set(Date.now());
	account ??= world.deps.cloudflare;
	return {
		...world.deps,
		cloudflare: account,
		names: sharedNames.names,
		store: new D1OperationStore(env.DB),
		ledger: new D1ResourceLedger(env.DB),
		custody: custodyOf({
			db: env.DB,
			secrets: { KEK_V1: KEK },
			pendingTtlMs: PENDING_TTL_MS,
			now: Date.now
		})
	};
}

const createStarter = {
	async create({ id, params }: { id: string; params: unknown }) {
		if (instances.has(id)) throw new Error('instance exists');
		instances.add(id);
		const { runner } = makeRunner(new Map());
		outcomes.set(
			id,
			await runSiteCreate(runner, await engineDeps(), params as SiteCreateInput)
		);
	},
	async get(id: string) {
		if (!instances.has(id)) throw new Error('not found');
		return {};
	}
} as unknown as WorkflowStarter;

const engine: EngineBinding = {
	async fetch(input, init) {
		const call = new Request(input as string, init);
		seen.push({ headers: call.headers, body: await call.clone().text() });
		return handleStart(call, {
			secret: START_SECRET,
			now: Date.now(),
			workflows: {
				'site-create': createStarter,
				'site-delete': createStarter,
				'site-purge': createStarter,
				'backup-create': createStarter,
				'backup-restore': createStarter
			}
		});
	}
};

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	built = buildServices({
		...env,
		KEK_V1: KEK,
		START_SECRET,
		ENGINE: engine,
		MANAGED_ACCOUNT_ID: ACCOUNT,
		RELEASE_DRUPAL: 'v1.0.4'
	} as BootEnv);
	setSiteServices(built.sites);
	setPendingSecretDeps(built.pendingSecrets);
	db = await built.sites.getDb();
	await ensurePersonalOrganization(db, 'user-1');
	await ensurePersonalOrganization(db, 'user-2');
});

afterAll(async () => {
	resetSiteServices();
	resetPendingSecretDeps();
	resetApiDeps();
	await open.close();
});

const ORG_ONE = 'org_user1';
const ORG_TWO = 'org_user2';

// the caller owns orgId; the loader answers it for every id it is asked about
function asMember(orgId: string) {
	setup({
		deps: {
			load: async (input) => ({
				resource: {
					orgId,
					...(input.params.id === undefined ? {} : { siteId: input.params.id })
				},
				facts: facts({ membership: { orgId, role: 'owner' }, ...fresh })
			})
		}
	});
}

const send = (
	handler: Parameters<typeof sendRequest>[0],
	route: string,
	req: Parameters<typeof sendRequest>[2]
): Promise<Reply> => sendRequest(handler, route, req);

function postCreate(
	orgId: string,
	body: { kind: string; name: string; hostnameLabel?: string },
	key: string,
	headers: Record<string, string> = asOtherUser
) {
	asMember(orgId);
	return send(sitesCreate, SITES_PATH, {
		method: 'POST',
		path: `/api/v1/orgs/${orgId}/sites`,
		headers: { ...headers, 'idempotency-key': key },
		json: body
	});
}

type Created = { id: string; status: string; targetIds: string[] };

const rowOf = <T>(sql: string, ...bindings: unknown[]) =>
	env.DB.prepare(sql)
		.bind(...bindings)
		.first<T>();

describe('create through the route to a live site', () => {
	it('starts a signed workflow, writes the engine plan, and ends with a ready site', async () => {
		const before = seen.length;
		const reply = await postCreate(
			ORG_TWO,
			{ kind: 'drupal', name: 'wired-otter' },
			'wire-0001'
		);
		expect(reply.status).toBe(202);
		const operation = reply.json as Created;
		const siteId = operation.targetIds[0]!;

		// the start the engine received verifies under the real verifier and names this operation
		expect(seen).toHaveLength(before + 1);
		const call = seen[before]!;
		const verdict = await verifyStart(call.headers, call.body, {
			secret: START_SECRET,
			now: Date.now()
		});
		if (!verdict.ok) throw new Error(`the start did not verify: ${verdict.code}`);
		expect(verdict.value).toMatchObject({ workflow: 'site-create', id: operation.id });
		const params = verdict.value.params as unknown as SiteCreateInput;
		expect(params).toMatchObject({
			operationId: operation.id,
			site: { id: siteId, orgId: ORG_TWO, accountId: ACCOUNT, plan: 'managed-free' },
			hostname: 'wired-otter.drupflare.app',
			releaseId: 'v1.0.4'
		});
		expect(JSON.stringify(params)).not.toContain(FAKE_ADMIN_PASSWORD);

		// the engine ran the create to its end over the same row
		expect(outcomes.get(operation.id)).toEqual({ status: 'succeeded' });
		expect(operation.status).toBe('succeeded');
		const row = await rowOf<{
			status: string;
			plan_digest: string;
			version: number;
			account_id: string;
		}>(
			'SELECT status, plan_digest, version, account_id FROM operations WHERE id = ?',
			operation.id
		);
		expect(row?.status).toBe('succeeded');
		expect(row?.plan_digest).toBe(await computePlanDigest(planSiteCreate(params)));
		expect(row?.version).toBeGreaterThan(0);
		expect(row?.account_id).toBe(ACCOUNT);
		const steps = await env.DB.prepare(
			'SELECT id, state FROM operation_steps WHERE operation_id = ? ORDER BY position'
		)
			.bind(operation.id)
			.all<{ id: string; state: string }>();
		expect(steps.results.map((step) => step.id)).toEqual(
			planSiteCreate(params).steps.map((step) => step.id)
		);
		expect(steps.results.every((step) => step.state === 'succeeded')).toBe(true);

		// the site shows once the engine activated it
		const ready = await getReadySite(db, ORG_TWO, siteId);
		expect(ready).toMatchObject({
			state: 'active',
			primaryHostname: 'wired-otter.drupflare.app'
		});
		expect(ready?.readyAt).not.toBeNull();
		asMember(ORG_TWO);
		const read = await send(siteRead, '/api/v1/sites/:id', {
			path: `/api/v1/sites/${siteId}`,
			headers: asOtherUser
		});
		expect(read.status).toBe(200);
	});

	it('refuses a replayed start, and a repeated key returns the one operation', async () => {
		const [first] = seen;
		const replay = await engine.fetch('https://engine/start', {
			method: 'POST',
			headers: Object.fromEntries(first!.headers),
			body: first!.body
		});
		expect(replay.status).toBe(409);
		expect(await replay.json()).toEqual({ ok: false, code: 'replayed' });

		const starts = seen.length;
		const again = await createSite(built.sites, {
			orgId: ORG_TWO,
			userId: 'user-2',
			kind: 'drupal',
			name: 'wired-otter',
			hostnameLabel: undefined,
			idempotencyKey: 'wire-0001'
		});
		expect(again.operation.targetIds[0]).toBe(
			(JSON.parse(first!.body).params as SiteCreateInput).site.id
		);
		const { n } = (await rowOf<{ n: number }>(
			'SELECT COUNT(*) AS n FROM operations WHERE organization_id = ? AND idempotency_key = ?',
			ORG_TWO,
			'wire-0001'
		))!;
		expect(n).toBe(1);
		expect(seen).toHaveLength(starts);
	});

	it('refuses a custom Worker on the free plan before anything starts', async () => {
		const starts = seen.length;
		const reply = await postCreate(
			ORG_TWO,
			{ kind: 'custom', name: 'custom-worker' },
			'wire-0004'
		);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			code: 'forbidden',
			details: { feature: 'site.create', reason: 'feature_not_included' }
		});
		expect(seen).toHaveLength(starts);
		expect(
			await rowOf('SELECT id FROM operations WHERE idempotency_key = ?', 'wire-0004')
		).toBeNull();
	});

	it('answers 501 and marks the operation failed when the engine binding is unset', async () => {
		const starts = seen.length;
		setSiteServices({
			startOperation: engineStarter({
				binding: undefined,
				secret: START_SECRET,
				now: Date.now
			})
		});
		try {
			const reply = await postCreate(
				ORG_TWO,
				{ kind: 'drupal', name: 'unbound-engine' },
				'wire-0005'
			);
			expect(reply.status).toBe(501);
			expect(reply.json).toMatchObject({ code: 'not_built' });
		} finally {
			setSiteServices({ startOperation: built.sites.startOperation });
		}
		const row = await rowOf<{ status: string; state: string }>(
			`SELECT o.status, s.state FROM operations o JOIN sites s ON s.id = o.site_id
			 WHERE o.organization_id = ? AND o.idempotency_key = ?`,
			ORG_TWO,
			'wire-0005'
		);
		expect(row).toEqual({ status: 'failed', state: 'deleted' });
		expect(seen).toHaveLength(starts);
	});

	it('reveals the sealed first admin password once, then answers 404', async () => {
		const created = await postCreate(
			ORG_TWO,
			{ kind: 'drupal', name: 'reveal-otter' },
			'wire-0006'
		);
		expect(created.status).toBe(202);
		expect((created.json as Created).status).toBe('succeeded');
		const siteId = (created.json as Created).targetIds[0]!;
		const path = `/api/v1/orgs/${ORG_TWO}/sites/${siteId}/first-run-secret`;
		const route = '/api/v1/orgs/:orgId/sites/:siteId/first-run-secret';
		asMember(ORG_TWO);
		const first = await send(reveal, route, { method: 'POST', path, headers: asOtherUser });
		expect(first.status).toBe(200);
		expect(first.headers.get('cache-control')).toBe('no-store');
		expect(first.json).toEqual({ kind: 'admin-password', value: FAKE_ADMIN_PASSWORD });
		const second = await send(reveal, route, { method: 'POST', path, headers: asOtherUser });
		expect(second.status).toBe(404);
		expect(second.text).not.toContain(FAKE_ADMIN_PASSWORD);
	});

	it('reports a name the engine could not reserve as a failed step with the reason', async () => {
		const label = 'shared-label';
		const winner = await postCreate(
			ORG_ONE,
			{ kind: 'drupal', name: label },
			'wire-0007a',
			asUser
		);
		expect((winner.json as Created).status).toBe('succeeded');
		const loser = await postCreate(ORG_TWO, { kind: 'drupal', name: label }, 'wire-0007b');
		// the dashboard did not check the name, so the create is accepted and fails in the engine
		expect(loser.status).toBe(202);
		const operation = loser.json as Created;
		expect(outcomes.get(operation.id)).toMatchObject({ status: 'rolled-back' });
		const reserve = await rowOf<{ state: string; error: string }>(
			"SELECT state, error FROM operation_steps WHERE operation_id = ? AND id = 'reserve-name'",
			operation.id
		);
		expect(reserve?.state).toBe('failed');
		expect(reserve?.error).toContain('cannot be reserved: taken');
		const site = await rowOf<{ state: string; ready_at: number | null }>(
			'SELECT state, ready_at FROM sites WHERE id = ?',
			operation.targetIds[0]
		);
		expect(site).toEqual({ state: 'deleted', ready_at: null });
		expect(await getReadySite(db, ORG_TWO, operation.targetIds[0]!)).toBeNull();
	});
});

describe('free plan limits', () => {
	it('allows three sites per person, then refuses the fourth in the organisation', async () => {
		const names = ['limit-one-site', 'limit-two-site'];
		for (const [index, name] of names.entries()) {
			const reply = await postCreate(
				ORG_ONE,
				{ kind: 'drupal', name },
				`wire-limit-${index}`,
				asUser
			);
			expect(reply.status).toBe(202);
		}
		const starts = seen.length;
		const fourth = await postCreate(
			ORG_ONE,
			{ kind: 'drupal', name: 'limit-four-site' },
			'wire-limit-3',
			asUser
		);
		expect(fourth.status).toBe(403);
		expect(fourth.json).toMatchObject({
			code: 'forbidden',
			details: { requires: 'entitlement', feature: 'site.create', reason: 'site_limit' }
		});
		expect(seen).toHaveLength(starts);
	});

	it('counts the same person across the organisations they own', async () => {
		const second = await createOrganization(db, {
			name: 'Second',
			personal: false,
			createdBy: 'user-1'
		});
		await addMember(db, second.id, { userId: 'user-1', role: 'owner' });
		const reply = await postCreate(
			second.id,
			{ kind: 'drupal', name: 'across-orgs' },
			'wire-limit-across',
			asUser
		);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { reason: 'free_limit' } });
	});
});

describe('change budget', () => {
	it('lists a budget as spent when running operations use all of it', async () => {
		const org = 'org_budget0001';
		const spent = collegeBudgets(async () => db);
		expect(await spent(org)).toEqual([]);
		const { operation } = await createSiteOperation(
			db,
			{
				id: 'site_budget000001',
				organizationId: org,
				name: 'budget-site',
				kind: 'drupal',
				category: 'cms',
				plane: 'managed',
				config: 'managed',
				primaryHostname: null,
				now: 1_000
			},
			{
				id: 'op_budget0000001',
				organizationId: org,
				accountId: null,
				siteId: 'site_budget000001',
				type: 'site.create',
				status: 'planned',
				idempotencyKey: 'budget-key',
				targetIds: ['site_budget000001'],
				preconditions: [],
				planDigest: `sha256:${'a'.repeat(64)}`,
				blastRadius: { sites: 1, destructiveSites: 0, productionDeploys: 0 },
				rollbackPoint: null,
				verification: 'pending',
				budget: DEFAULT_CHANGE_BUDGET,
				steps: [],
				now: 1_000
			}
		);
		const radius = JSON.stringify({
			sites: 5,
			destructiveSites: DEFAULT_CHANGE_BUDGET.maxDestructiveSites,
			productionDeploys: DEFAULT_CHANGE_BUDGET.maxConcurrentProductionDeploys
		});
		await env.DB.prepare(
			"UPDATE operations SET status = 'running', blast_radius = ? WHERE id = ?"
		)
			.bind(radius, operation.operation.id)
			.run();
		expect((await spent(org)).sort()).toEqual(['destructive-sites', 'production-deploys']);
		await env.DB.prepare("UPDATE operations SET status = 'succeeded' WHERE id = ?")
			.bind(operation.operation.id)
			.run();
		expect(await spent(org)).toEqual([]);
	});
});
