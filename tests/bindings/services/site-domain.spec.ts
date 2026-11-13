import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import domainRead from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/domain/index.get';
import domainStart from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/domain/index.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { markSiteReady } from '../../../src/server/db/repos/sites';
import { advance, startState, type AttachEvent } from '../../../src/server/domain/domain-attach';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import { EngineStartError, type EngineStartRequest } from '../../../src/server/integrations/engine';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import { startDomainAttach } from '../../../src/server/services/site-domain';
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
import { asKey, asUser, send, setup } from '../../unit/server/fixtures/harness';
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

const BASE = '/api/v1/orgs/:orgId/sites/:id/domain';
const ACCOUNT = 'd'.repeat(32);
const HOST = 'www.example.edu';
const BODY = { hostname: HOST };

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

function install() {
	const started: EngineStartRequest[] = [];
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
	return { started };
}

let counter = 0;
const key = () => `domain-key-${++counter}-${Date.now()}`;

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

const path = (siteId: string) => `/api/v1/orgs/${ORG}/sites/${siteId}/domain`;

const start = (siteId: string, json: unknown = BODY, headers: Record<string, string> = asUser) =>
	send(domainStart, BASE, {
		method: 'POST',
		path: path(siteId),
		headers: { ...headers, 'idempotency-key': key() },
		json
	});

const read = (siteId: string, headers = asUser) =>
	send(domainRead, BASE, { path: path(siteId), headers });

const operationRows = async (siteId: string) =>
	(
		await env.DB.prepare(
			'SELECT id, type, status, inputs, cursor FROM operations WHERE site_id = ? ORDER BY created_at, rowid'
		)
			.bind(siteId)
			.all<{
				id: string;
				type: string;
				status: string;
				inputs: string | null;
				cursor: string | null;
			}>()
	).results;

const RECORDS = [
	{ purpose: 'ownership', type: 'TXT', name: `_cf-custom-hostname.${HOST}`, value: 'own-1' },
	{ purpose: 'traffic', type: 'CNAME', name: HOST, value: 'edge.example.net' }
] as const;

function cursorAfter(...events: AttachEvent[]): string {
	let state = startState(HOST, 1_000);
	for (const event of events) state = advance(state, event, 2_000);
	return JSON.stringify(state);
}

async function started(siteId: string, cursor: string | null, status = 'running') {
	asRole('owner');
	const reply = await start(siteId);
	expect(reply.status).toBe(202);
	const operationId = (reply.json as { id: string }).id;
	await env.DB.prepare('UPDATE operations SET status = ?, cursor = ? WHERE id = ?')
		.bind(status, cursor, operationId)
		.run();
	return operationId;
}

describe('who may use the domain routes', () => {
	it('gives owners and admins the site actions and no one below them', () => {
		for (const action of ['site.domain.manage', 'site.domain.read'] as const) {
			expect(ACTION_DEFS[action].org).toEqual(['owner', 'admin']);
			expect(ACTION_DEFS[action].site).toEqual(['site-admin']);
			const allowed = ['owner', 'admin', 'developer', 'viewer'].filter(
				(role) =>
					allowedSet([action], facts({ ...member(role as 'owner'), ...fresh })).length > 0
			);
			expect(allowed).toEqual(['owner', 'admin']);
		}
	});

	it('marks the start session only with a step-up and the read as neither', () => {
		expect(isSessionOnly('site.domain.manage')).toBe(true);
		expect(ACTION_DEFS['site.domain.manage']).toMatchObject({ stepUp: true });
		expect(isSessionOnly('site.domain.read')).toBe(false);
		expect(ACTION_DEFS['site.domain.read']).not.toHaveProperty('stepUp');
	});

	it('refuses a viewer and a developer on both routes before anything is read', async () => {
		install();
		const siteId = await site(ORG, 'domain-roles-site');
		for (const role of ['viewer', 'developer'] as const) {
			asRole(role);
			const replies = await Promise.all([start(siteId), read(siteId)]);
			expect(replies.map((reply) => reply.status)).toEqual([403, 403]);
		}
		expect(await operationRows(siteId)).toHaveLength(1);
	});

	it('lets an owner read, and refuses the start without a recent step-up', async () => {
		install();
		const siteId = await site(ORG, 'domain-stepup-site');
		asRole('owner', { stepUp: false });
		expect((await read(siteId)).status).toBe(200);
		const reply = await start(siteId);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(await operationRows(siteId)).toHaveLength(1);
	});

	it('refuses a key on the start, whatever its scopes', async () => {
		install();
		const siteId = await site(ORG, 'domain-key-site');
		const { denials } = setup({
			facts: () => ({
				...facts({ ...member('owner'), ...fresh }),
				key: { id: 'key-1', scopes: ['site.domain.manage'] }
			})
		});
		expect((await start(siteId, BODY, asKey)).status).toBe(403);
		expect(denials.map((denial) => denial.reason)).toEqual(['session_only']);
	});
});

describe('POST a domain', () => {
	it('answers 202 with a domain.attach operation and starts the workflow once', async () => {
		const { started: sent } = install();
		const siteId = await site(ORG, 'domain-start-site');
		sent.length = 0;
		asRole('owner');
		const reply = await start(siteId, { hostname: 'WWW.Example.EDU' });
		expect(reply.status).toBe(202);
		const operation = reply.json as {
			id: string;
			type: string;
			status: string;
			targetIds: string[];
		};
		expect(operation).toMatchObject({ type: 'domain.attach', status: 'planned' });
		expect(operation.targetIds).toEqual([siteId]);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ workflow: 'domain-attach', id: operation.id });
		expect(sent[0]!.params).toMatchObject({
			operationId: operation.id,
			orgId: ORG,
			siteId,
			accountId: ACCOUNT,
			hostname: HOST
		});
		const rows = await operationRows(siteId);
		expect(rows.map((row) => row.type)).toEqual(['site.create', 'domain.attach']);
		expect(JSON.parse(rows[1]!.inputs!)).toMatchObject({ hostname: HOST });
	});

	it('returns the same operation for a repeated key and starts once', async () => {
		const { started: sent } = install();
		const siteId = await site(ORG, 'domain-repeat-site');
		sent.length = 0;
		asRole('owner');
		const headers = { ...asUser, 'idempotency-key': key() };
		const first = await send(domainStart, BASE, {
			method: 'POST',
			path: path(siteId),
			headers,
			json: BODY
		});
		const second = await send(domainStart, BASE, {
			method: 'POST',
			path: path(siteId),
			headers,
			json: BODY
		});
		expect(second.status).toBe(202);
		expect(second.json).toEqual(first.json);
		expect(sent).toHaveLength(1);
	});

	it('refuses a key that belongs to another site or another domain', async () => {
		install();
		const one = await site(ORG, 'domain-reuse-one');
		const two = await site(ORG, 'domain-reuse-two');
		asRole('owner');
		const shared = key();
		await send(domainStart, BASE, {
			method: 'POST',
			path: path(one),
			headers: { ...asUser, 'idempotency-key': shared },
			json: BODY
		});
		for (const [siteId, hostname] of [
			[two, HOST],
			[one, 'other.example.edu']
		] as const) {
			const caught = await startDomainAttach(siteServices(), {
				orgId: ORG,
				siteId,
				hostname,
				idempotencyKey: shared
			}).catch((error: unknown) => error);
			expect(caught).toBeInstanceOf(ApiError);
			expect(caught).toMatchObject({ details: { reason: 'idempotency_key_reused' } });
		}
	});

	it.each([
		['www.drupflare.app', 'platform_zone'],
		['drupflare.com', 'platform_zone'],
		['a.b.drupflare.com', 'platform_zone'],
		['*.example.edu', 'wildcard'],
		['localhost', 'invalid'],
		['10.0.0.1', 'invalid']
	])('answers 422 for %s and starts nothing', async (hostname, reason) => {
		const { started: sent } = install();
		const siteId = await site(ORG, `domain-refuse-${++counter}`);
		sent.length = 0;
		asRole('owner');
		const reply = await start(siteId, { hostname });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason } });
		expect(sent).toHaveLength(0);
		expect(await operationRows(siteId)).toHaveLength(1);
	});

	it('answers 422 for a site that is not a live managed site', async () => {
		const { started: sent } = install();
		const selfManaged = await site(ORG, 'domain-selfmanaged-site', 'self-managed');
		const tombstoned = await site(ORG, 'domain-tombstoned-site');
		await env.DB.prepare('UPDATE sites SET state = ? WHERE id = ?')
			.bind('tombstoned', tombstoned)
			.run();
		sent.length = 0;
		asRole('owner');
		for (const siteId of [selfManaged, tombstoned]) {
			const reply = await start(siteId);
			expect(reply.status).toBe(422);
			expect(reply.json).toMatchObject({ details: { reason: 'site_not_live' } });
		}
		expect(sent).toHaveLength(0);
	});

	it('answers 409 while another operation on the site is running, and holds the site once started', async () => {
		const { started: sent } = install();
		const siteId = await site(ORG, 'domain-busy-site');
		const [created] = await operationRows(siteId);
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('running', created!.id)
			.run();
		sent.length = 0;
		asRole('owner');
		const busy = await start(siteId);
		expect(busy.status).toBe(409);
		expect(busy.json).toMatchObject({ details: { reason: 'site_busy' } });
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('succeeded', created!.id)
			.run();
		expect((await start(siteId)).status).toBe(202);
		expect((await start(siteId)).status).toBe(409);
		expect(sent).toHaveLength(1);
	});

	it('answers 404 for a site of another organisation', async () => {
		const { started: sent } = install();
		const siteId = await site(OTHER_ORG, 'domain-foreign-site');
		sent.length = 0;
		asRole('owner');
		expect((await start(siteId)).status).toBe(404);
		expect(sent).toHaveLength(0);
	});

	it('rejects a bad body and a missing key', async () => {
		install();
		const siteId = await site(ORG, 'domain-body-site');
		asRole('owner');
		for (const json of [
			{},
			{ hostname: '' },
			{ hostname: HOST, extra: true },
			{ hostname: 3 }
		]) {
			expect((await start(siteId, json)).status).toBe(400);
		}
		const noKey = await send(domainStart, BASE, {
			method: 'POST',
			path: path(siteId),
			headers: asUser,
			json: BODY
		});
		expect(noKey.status).toBe(400);
	});

	it('fails the operation and says so when the engine refuses the start', async () => {
		install();
		const siteId = await site(ORG, 'domain-refused-site');
		setSiteServices({
			startOperation: async () => {
				throw new EngineStartError('unavailable', 'the engine did not answer');
			}
		});
		asRole('owner');
		const reply = await start(siteId);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'unavailable' } });
		const rows = await operationRows(siteId);
		expect(rows.at(-1)).toMatchObject({ type: 'domain.attach', status: 'failed' });
	});
});

describe('GET the domain of a site', () => {
	it('says a live site can take a domain and has no attach yet', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-site');
		asRole('owner');
		const reply = await read(siteId);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ ready: true, attached: [], attach: null });
	});

	it('says a site that is not live cannot take one', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-selfmanaged', 'self-managed');
		asRole('owner');
		expect((await read(siteId)).json).toMatchObject({ ready: false });
	});

	it('shows four waiting stages for an attach the engine has not written to yet', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-fresh');
		await started(siteId, null, 'planned');
		const attach = ((await read(siteId)).json as { attach: Record<string, unknown> }).attach;
		expect(attach).toMatchObject({ hostname: HOST, status: 'running', checks: 0, records: [] });
		expect((attach.stages as { state: string }[]).map((stage) => stage.state)).toEqual([
			'waiting',
			'waiting',
			'waiting',
			'waiting'
		]);
	});

	it('shows the stage states, the records to add and no reason while it runs', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-running');
		await started(
			siteId,
			cursorAfter(
				{ type: 'requested', records: [...RECORDS] },
				{
					type: 'observed',
					observation: {
						hostnameStatus: 'active',
						certificateStatus: 'pending',
						records: [...RECORDS]
					}
				}
			)
		);
		const attach = ((await read(siteId)).json as { attach: Record<string, unknown> }).attach;
		expect(attach).toMatchObject({ status: 'running', reason: null, records: RECORDS });
		const stages = attach.stages as { id: string; label: string; state: string }[];
		expect(stages.map((stage) => `${stage.id}:${stage.state}`)).toEqual([
			'ownership:done',
			'certificate:pending',
			'routing:waiting',
			'verification:waiting'
		]);
	});

	it('shows the plain reason of a stopped attach and keeps the records visible', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-failed');
		await started(
			siteId,
			cursorAfter(
				{ type: 'requested', records: [...RECORDS] },
				{ type: 'failed', code: 'wait_timed_out' }
			),
			'failed'
		);
		const attach = ((await read(siteId)).json as { attach: Record<string, unknown> }).attach;
		expect(attach).toMatchObject({ status: 'failed', records: RECORDS });
		expect(attach.reason).toMatch(/did not appear in time/);
	});

	it('gives a plain reason to an attach that closed without writing one', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-closed');
		await started(siteId, null, 'cancelled');
		const attach = ((await read(siteId)).json as { attach: { status: string; reason: string } })
			.attach;
		expect(attach.status).toBe('failed');
		expect(attach.reason).toBe('The change was cancelled before it started.');
	});

	it('lists only the domains routed to this site in this organisation', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-attached');
		const other = await site(ORG, 'domain-read-attached-other');
		const insert = (hostname: string, site_id: string, state: string, organization = ORG) =>
			env.DB.prepare(
				`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
				provider_id, created_at, updated_at) VALUES (?, ?, ?, 'op_x', 1, ?, NULL, 10, 20)`
			)
				.bind(hostname, organization, site_id, state)
				.run();
		await insert('b.example.edu', siteId, 'routed');
		await insert('a.example.edu', siteId, 'routed');
		await insert('c.example.edu', siteId, 'claimed');
		await insert('d.example.edu', siteId, 'released');
		await insert('e.example.edu', other, 'routed');
		asRole('owner');
		expect((await read(siteId)).json).toMatchObject({
			attached: [
				{ hostname: 'a.example.edu', since: 20 },
				{ hostname: 'b.example.edu', since: 20 }
			]
		});
	});

	it('answers 404 for a site of another organisation', async () => {
		install();
		const siteId = await site(OTHER_ORG, 'domain-read-foreign');
		asRole('owner');
		expect((await read(siteId)).status).toBe(404);
	});
});
