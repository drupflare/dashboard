import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import cutoverApprove from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/cutover/approve.post';
import cutoverChoice from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/cutover/choice.post';
import cutoverRead from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/cutover/index.get';
import cutoverStart from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/cutover/index.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { markSiteReady } from '../../../src/server/db/repos/sites';
import {
	initialState,
	next,
	type CutoverEvent,
	type CutoverState
} from '../../../src/server/domain/cutover';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import {
	EngineStartError,
	type EngineEventRequest,
	type EngineStartRequest
} from '../../../src/server/integrations/engine';
import {
	resetCutoverServices,
	setCutoverServices,
	startCutover
} from '../../../src/server/services/migration-cutover';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import {
	createSite,
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { ApiError } from '../../../src/shared/errors';
import { ACTION_DEFS, isSessionOnly } from '../../../src/shared/permissions';
import { DEPT, ORG, OTHER_ORG, allowedSet, facts, fresh, member } from '../../unit/domain/fixtures';
import { asKey, asUser, send, setup, type Reply } from '../../unit/server/fixtures/harness';
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
	resetCutoverServices();
	resetPendingSecretDeps();
	resetApiDeps();
});

const BASE = '/api/v1/orgs/:orgId/sites/:id/cutover';
const ACCOUNT = 'c'.repeat(32);
const AT = '2026-11-12T10:00:00.000Z';
const BODY = { policy: 'freeze', source: { ref: 'source-1' }, hostname: 'www.example.test' };

function asRole(
	role: 'owner' | 'admin' | 'developer' | 'viewer',
	options: { stepUp?: boolean } = {}
) {
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

const entitlement = () => {
	const result = derive(FREE_PLAN_ID);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

function install(options: { built?: boolean } = {}) {
	const started: EngineStartRequest[] = [];
	const events: EngineEventRequest[] = [];
	const audits: { orgId: string; action: string; target: string; detail?: unknown }[] = [];
	const failure: { event: Error | null } = { event: null };
	installPendingSecrets(getDb);
	setSiteServices({
		getDb,
		entitlements: { check: async () => ({ allow: true, entitlement: entitlement() }) },
		planOf: async () => entitlement(),
		startOperation: async (request) => {
			started.push(request);
		},
		config: {
			hostSuffix: 'drupflare.app',
			accountId: 'a'.repeat(32),
			releases: { drupal: 'v1.0.5' }
		}
	});
	setCutoverServices({
		adaptersBuilt: options.built ?? true,
		sendEvent: async (request) => {
			if (failure.event !== null) throw failure.event;
			events.push(request);
		},
		audit: async (orgId, input) => {
			audits.push({
				orgId,
				action: input.action,
				target: input.target,
				detail: input.detail
			});
		}
	});
	return { started, events, audits, failure };
}

let counter = 0;
const key = () => `cutover-key-${++counter}-${Date.now()}`;

// a live site on the plane named, in an account of its own
async function site(orgId: string, name: string, plane = 'managed') {
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
		.bind(ACCOUNT, plane, `${name}.example.test`, siteId)
		.run();
	await markSiteReady(await getDb(), orgId, siteId, 5_000);
	return siteId;
}

const path = (siteId: string, tail = '') => `/api/v1/orgs/${ORG}/sites/${siteId}/cutover${tail}`;

const start = (siteId: string, json: unknown = BODY, headers: Record<string, string> = asUser) =>
	send(cutoverStart, BASE, {
		method: 'POST',
		path: path(siteId),
		headers: { ...headers, 'idempotency-key': key() },
		json
	});

const read = (siteId: string, headers = asUser) =>
	send(cutoverRead, BASE, { path: path(siteId), headers });

const approve = (siteId: string, headers = asUser) =>
	send(cutoverApprove, `${BASE}/approve`, {
		method: 'POST',
		path: path(siteId, '/approve'),
		headers
	});

const choose = (siteId: string, value: string, headers = asUser) =>
	send(cutoverChoice, `${BASE}/choice`, {
		method: 'POST',
		path: path(siteId, '/choice'),
		headers,
		json: { value }
	});

function stateAt(events: CutoverEvent[]): CutoverState {
	let state = next(initialState('freeze', 120), { type: 'start' }, AT).state;
	for (const event of events) state = next(state, event, AT).state;
	return state;
}

const BEFORE_APPROVAL: CutoverEvent[] = [
	{ type: 'ttl-lowered', previousTtlSeconds: 3600 },
	{ type: 'snapshot-taken', marker: 'snap-1' },
	{ type: 'delta-captured', marker: 'delta-1' },
	{ type: 'validated', problem: null }
];
const OBSERVING: CutoverEvent[] = [
	...BEFORE_APPROVAL,
	{ type: 'approved' },
	{ type: 'policy-applied' },
	{ type: 'final-delta', marker: 'delta-2', problem: null },
	{ type: 'promoted' },
	{ type: 'routed' }
];

async function startedCutover(siteId: string, events: CutoverEvent[]) {
	const reply = await start(siteId);
	expect(reply.status).toBe(202);
	const operationId = (reply.json as { id: string }).id;
	await env.DB.prepare("UPDATE operations SET status = 'running', cursor = ? WHERE id = ?")
		.bind(JSON.stringify(stateAt(events)), operationId)
		.run();
	return operationId;
}

const operationRows = async (siteId: string) =>
	(
		await env.DB.prepare(
			'SELECT id, type, status, inputs FROM operations WHERE site_id = ? ORDER BY created_at, rowid'
		)
			.bind(siteId)
			.all<{ id: string; type: string; status: string; inputs: string | null }>()
	).results;

describe('who may use the cutover routes', () => {
	const ACTIONS = ['site.cutover', 'site.cutover.decide', 'site.cutover.read'] as const;

	it('gives owners and admins the site actions and no one below them', () => {
		for (const action of ACTIONS) {
			expect(ACTION_DEFS[action].org).toEqual(['owner', 'admin']);
			expect(ACTION_DEFS[action].site).toEqual(['site-admin']);
			const allowed = ['owner', 'admin', 'developer', 'viewer'].filter(
				(role) =>
					allowedSet([action], facts({ ...member(role as 'owner'), ...fresh })).length > 0
			);
			expect(allowed).toEqual(['owner', 'admin']);
		}
	});

	it('marks start, approve and choice session only with a step-up, and the read as neither', () => {
		expect(isSessionOnly('site.cutover')).toBe(true);
		expect(isSessionOnly('site.cutover.decide')).toBe(true);
		expect(isSessionOnly('site.cutover.read')).toBe(false);
		expect(ACTION_DEFS['site.cutover']).toMatchObject({ stepUp: true });
		expect(ACTION_DEFS['site.cutover.decide']).toMatchObject({ stepUp: true });
		expect(ACTION_DEFS['site.cutover.read']).not.toHaveProperty('stepUp');
	});

	it('refuses a viewer and a developer on every route before anything is read', async () => {
		install();
		const siteId = await site(ORG, 'cutover-roles-site');
		for (const role of ['viewer', 'developer'] as const) {
			asRole(role);
			const replies = await Promise.all([
				start(siteId),
				read(siteId),
				approve(siteId),
				choose(siteId, 'keep-new')
			]);
			expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403, 403]);
		}
		expect(await operationRows(siteId)).toHaveLength(1);
	});

	it('lets an admin read, and refuses a signed-in owner without a recent step-up on the writes', async () => {
		install();
		const siteId = await site(ORG, 'cutover-stepup-site');
		asRole('owner', { stepUp: false });
		expect((await read(siteId)).status).toBe(200);
		const replies = await Promise.all([
			start(siteId),
			approve(siteId),
			choose(siteId, 'keep-new')
		]);
		expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403]);
		expect(replies[0]!.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(await operationRows(siteId)).toHaveLength(1);
	});

	it('refuses a key on the three writes, whatever its scopes', async () => {
		install();
		const siteId = await site(ORG, 'cutover-key-site');
		const { denials } = setup({
			facts: () => ({
				...facts({ ...member('owner'), ...fresh }),
				key: { id: 'key-1', scopes: [...ACTIONS] }
			})
		});
		const replies = await Promise.all([
			start(siteId, BODY, asKey),
			approve(siteId, asKey),
			choose(siteId, 'keep-new', asKey)
		]);
		expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403]);
		expect(denials.map((denial) => denial.reason)).toEqual([
			'session_only',
			'session_only',
			'session_only'
		]);
	});
});

describe('POST a cutover', () => {
	it('answers 202 with a migration.cutover operation on the new site and starts the workflow once', async () => {
		const { started } = install();
		const siteId = await site(ORG, 'cutover-start-site');
		started.length = 0;
		asRole('owner');
		const reply = await start(siteId);
		expect(reply.status).toBe(202);
		const operation = reply.json as {
			id: string;
			type: string;
			status: string;
			targetIds: string[];
		};
		expect(operation).toMatchObject({ type: 'migration.cutover', status: 'planned' });
		expect(operation.targetIds).toEqual([siteId]);
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ workflow: 'migration-cutover', id: operation.id });
		expect(started[0]!.params).toMatchObject({
			operationId: operation.id,
			orgId: ORG,
			site: { id: siteId, accountId: ACCOUNT },
			source: { ref: 'source-1' },
			hostname: 'www.example.test',
			policy: 'freeze',
			ttlSeconds: 60,
			expectedWindowSeconds: 180
		});
		const rows = await operationRows(siteId);
		expect(rows.map((row) => row.type)).toEqual(['site.create', 'migration.cutover']);
		expect(JSON.parse(rows[1]!.inputs!)).toMatchObject({ policy: 'freeze' });
	});

	it('states a shorter window for the delta policy', async () => {
		const { started } = install();
		const siteId = await site(ORG, 'cutover-delta-site');
		started.length = 0;
		asRole('owner');
		await start(siteId, { ...BODY, policy: 'delta' });
		expect(started[0]!.params).toMatchObject({ policy: 'delta', expectedWindowSeconds: 120 });
	});

	it('returns the same operation for a repeated key and starts once', async () => {
		const { started } = install();
		const siteId = await site(ORG, 'cutover-repeat-site');
		started.length = 0;
		asRole('owner');
		const repeated = key();
		const headers = { ...asUser, 'idempotency-key': repeated };
		const first = await send(cutoverStart, BASE, {
			method: 'POST',
			path: path(siteId),
			headers,
			json: BODY
		});
		const second = await send(cutoverStart, BASE, {
			method: 'POST',
			path: path(siteId),
			headers,
			json: BODY
		});
		expect(second.status).toBe(202);
		expect(second.json).toEqual(first.json);
		expect(started).toHaveLength(1);
	});

	it('refuses a key that belongs to another request', async () => {
		install();
		const one = await site(ORG, 'cutover-reuse-one');
		const two = await site(ORG, 'cutover-reuse-two');
		asRole('owner');
		const shared = key();
		await send(cutoverStart, BASE, {
			method: 'POST',
			path: path(one),
			headers: { ...asUser, 'idempotency-key': shared },
			json: BODY
		});
		const caught = await startCutover(
			siteServices(),
			{
				...(
					await import('../../../src/server/services/migration-cutover')
				).cutoverServices()
			},
			{
				orgId: ORG,
				siteId: two,
				policy: 'freeze',
				source: { ref: 'source-1' },
				hostname: 'www.example.test',
				idempotencyKey: shared
			}
		).catch((error: unknown) => error);
		expect(caught).toBeInstanceOf(ApiError);
		expect(caught).toMatchObject({ details: { reason: 'idempotency_key_reused' } });
	});

	it('answers 501 until the source and destination adapters exist', async () => {
		const { started } = install({ built: false });
		const siteId = await site(ORG, 'cutover-unbuilt-site');
		started.length = 0;
		asRole('owner');
		expect((await start(siteId)).status).toBe(501);
		expect(started).toHaveLength(0);
	});

	it('answers 422 for a site that is not a live managed site', async () => {
		const { started } = install();
		const selfManaged = await site(ORG, 'cutover-selfmanaged-site', 'self-managed');
		const tombstoned = await site(ORG, 'cutover-tombstoned-site');
		await env.DB.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.bind('tombstoned', tombstoned)
			.run();
		started.length = 0;
		asRole('owner');
		for (const siteId of [selfManaged, tombstoned]) {
			const reply = await start(siteId);
			expect(reply.status).toBe(422);
			expect(reply.json).toMatchObject({ details: { reason: 'no_ready_destination' } });
		}
		expect(started).toHaveLength(0);
	});

	it('answers 409 while another operation on the site is running, and holds the site once started', async () => {
		const { started } = install();
		const siteId = await site(ORG, 'cutover-busy-site');
		const [created] = await operationRows(siteId);
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('running', created!.id)
			.run();
		started.length = 0;
		asRole('owner');
		const busy = await start(siteId);
		expect(busy.status).toBe(409);
		expect(busy.json).toMatchObject({ details: { reason: 'site_busy' } });
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('succeeded', created!.id)
			.run();
		expect((await start(siteId)).status).toBe(202);
		expect((await start(siteId)).status).toBe(409);
		expect(started).toHaveLength(1);
	});

	it('answers 404 for a site of another organisation', async () => {
		const { started } = install();
		const siteId = await site(OTHER_ORG, 'cutover-foreign-site');
		started.length = 0;
		asRole('owner');
		expect((await start(siteId)).status).toBe(404);
		expect(started).toHaveLength(0);
	});

	it('rejects a bad body and a missing key', async () => {
		install();
		const siteId = await site(ORG, 'cutover-body-site');
		asRole('owner');
		for (const json of [
			{ ...BODY, policy: 'pause' },
			{ ...BODY, hostname: 'not a host' },
			{ ...BODY, source: { ref: '' } },
			{ ...BODY, extra: true },
			{ policy: 'freeze' }
		]) {
			expect((await start(siteId, json)).status).toBe(400);
		}
		const noKey = await send(cutoverStart, BASE, {
			method: 'POST',
			path: path(siteId),
			headers: asUser,
			json: BODY
		});
		expect(noKey.status).toBe(400);
	});

	it('fails the operation and says so when the engine refuses the start', async () => {
		install();
		const siteId = await site(ORG, 'cutover-refused-site');
		setSiteServices({
			startOperation: async () => {
				throw new EngineStartError('unavailable', 'the engine did not answer');
			}
		});
		asRole('owner');
		const reply = await start(siteId);
		expect(reply.status).toBe(422);
		const rows = await operationRows(siteId);
		expect(rows.at(-1)).toMatchObject({ type: 'migration.cutover', status: 'failed' });
	});
});

describe('GET the plan and state', () => {
	it('reports the windows, the four points and no move for a site that has had none', async () => {
		install();
		const siteId = await site(ORG, 'cutover-read-site');
		asRole('admin');
		const reply = await read(siteId);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			ready: true,
			available: true,
			policies: [
				{ policy: 'freeze', expectedWindowSeconds: 180 },
				{ policy: 'read-only', expectedWindowSeconds: 180 },
				{ policy: 'delta', expectedWindowSeconds: 120 }
			],
			observationOffsetsMs: [300_000, 1_800_000, 21_600_000, 86_400_000],
			cutover: null
		});
	});

	it('says a site that cannot take a move is not ready and that moves are not available yet', async () => {
		install({ built: false });
		const siteId = await site(ORG, 'cutover-notready-site', 'self-managed');
		asRole('admin');
		expect((await read(siteId)).json).toMatchObject({ ready: false, available: false });
	});

	it('reads the latest move with its steps, its write count and the boundary', async () => {
		install();
		const siteId = await site(ORG, 'cutover-state-site');
		asRole('owner');
		const operationId = await startedCutover(siteId, OBSERVING);
		const reply = await read(siteId);
		expect(reply.json).toMatchObject({
			cutover: {
				operationId,
				siteId,
				policy: 'freeze',
				state: 'observing',
				boundary: 'dns-reversal',
				destinationWrites: 0,
				snapshotMarker: 'snap-1',
				sourceDestroyed: false
			}
		});
		const view = (reply.json as { cutover: { steps: { id: string }[] } }).cutover;
		expect(view.steps.map((step) => step.id)).toContain('owner-approval');
	});

	it('shows the post-write boundary once a write is counted', async () => {
		install();
		const siteId = await site(ORG, 'cutover-boundary-site');
		asRole('owner');
		await startedCutover(siteId, [...OBSERVING, { type: 'writes-counted', writes: 4 }]);
		expect((await read(siteId)).json).toMatchObject({
			cutover: { boundary: 'post-write', destinationWrites: 4 }
		});
	});

	it('answers 404 for a site of another organisation', async () => {
		install();
		const siteId = await site(OTHER_ORG, 'cutover-read-foreign');
		asRole('owner');
		expect((await read(siteId)).status).toBe(404);
	});
});

describe('POST an approval', () => {
	it('sends the approval to the waiting move and records who gave it', async () => {
		const { events, audits } = install();
		const siteId = await site(ORG, 'cutover-approve-site');
		asRole('owner');
		const operationId = await startedCutover(siteId, BEFORE_APPROVAL);
		const reply = await approve(siteId);
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({ operationId, state: 'awaiting-approval' });
		expect(events).toEqual([
			{
				workflow: 'migration-cutover',
				id: operationId,
				type: 'cutover-approval',
				payload: { approvedBy: 'user:user-1' }
			}
		]);
		expect(audits).toEqual([
			{
				orgId: ORG,
				action: 'site.cutover.approve',
				target: siteId,
				detail: { operationId, policy: 'freeze' }
			}
		]);
	});

	it('answers 409 when the move is not waiting for approval and sends nothing', async () => {
		const { events } = install();
		const siteId = await site(ORG, 'cutover-approve-early');
		asRole('owner');
		await startedCutover(siteId, OBSERVING);
		const reply = await approve(siteId);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'not_awaiting_approval' } });
		expect(events).toEqual([]);
	});

	it('answers 404 when no move has started and 409 when the move is no longer running', async () => {
		const { failure } = install();
		const siteId = await site(ORG, 'cutover-approve-gone');
		asRole('owner');
		expect((await approve(siteId)).status).toBe(404);
		await startedCutover(siteId, BEFORE_APPROVAL);
		failure.event = new EngineStartError('not_running', 'the engine refused the event');
		const reply = await approve(siteId);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'not_waiting' } });
	});

	it('answers 422 when the engine cannot take the event', async () => {
		const { failure } = install();
		const siteId = await site(ORG, 'cutover-approve-down');
		asRole('owner');
		await startedCutover(siteId, BEFORE_APPROVAL);
		failure.event = new EngineStartError('unavailable', 'the engine did not answer');
		expect((await approve(siteId)).status).toBe(422);
	});
});

describe('POST a choice', () => {
	it('sends a reversal request and each of the three choices to the observing move', async () => {
		const { events, audits } = install();
		const siteId = await site(ORG, 'cutover-choice-site');
		asRole('owner');
		const operationId = await startedCutover(siteId, OBSERVING);
		for (const value of ['rollback', 'keep-new', 'abandon-new-data', 'export-changes']) {
			expect((await choose(siteId, value)).status).toBe(202);
		}
		expect(events.map((event) => [event.type, event.payload])).toEqual([
			['cutover-decision', { kind: 'rollback' }],
			['cutover-decision', { kind: 'choice', value: 'keep-new' }],
			['cutover-decision', { kind: 'choice', value: 'abandon-new-data' }],
			['cutover-decision', { kind: 'choice', value: 'export-changes' }]
		]);
		expect(events.every((event) => event.id === operationId)).toBe(true);
		expect(audits.map((audit) => audit.action)).toEqual(Array(4).fill('site.cutover.decide'));
		expect(audits[0]!.detail).toMatchObject({ value: 'rollback', writes: 0 });
	});

	it('answers 409 before the move reaches the new site and sends nothing', async () => {
		const { events } = install();
		const siteId = await site(ORG, 'cutover-choice-early');
		asRole('owner');
		await startedCutover(siteId, BEFORE_APPROVAL);
		const reply = await choose(siteId, 'keep-new');
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'not_observing' } });
		expect(events).toEqual([]);
	});

	it('rejects a value it does not know and answers 404 when no move has started', async () => {
		install();
		const siteId = await site(ORG, 'cutover-choice-bad');
		asRole('owner');
		expect((await choose(siteId, 'keep-new')).status).toBe(404);
		expect((await choose(siteId, 'delete-source')).status).toBe(400);
	});

	it('answers 409 when the move is no longer running', async () => {
		const { failure } = install();
		const siteId = await site(ORG, 'cutover-choice-gone');
		asRole('owner');
		await startedCutover(siteId, OBSERVING);
		failure.event = new EngineStartError('not_running', 'the engine refused the event');
		const reply: Reply = await choose(siteId, 'keep-new');
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'not_waiting' } });
	});
});
