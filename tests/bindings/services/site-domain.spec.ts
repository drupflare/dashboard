import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import domainCheck from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/domain/check.post';
import domainRead from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/domain/index.get';
import domainStart from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/domain/index.post';
import domainRelease from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/domain/release.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getClaim } from '../../../src/server/db/repos/custom-domains';
import { markSiteReady } from '../../../src/server/db/repos/sites';
import {
	DEFAULT_WAIT_MS,
	advance,
	startState,
	type AttachEvent
} from '../../../src/server/domain/domain-attach';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import { EngineStartError, type EngineStartRequest } from '../../../src/server/integrations/engine';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import {
	resetDomainServices,
	setDomainServices,
	startDomainAttach
} from '../../../src/server/services/site-domain';
import {
	createSite,
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { deriveChallenge, loadChallengeKeys } from '../../../src/shared/custody/challenge';
import { ApiError } from '../../../src/shared/errors';
import { ACTION_DEFS, isSessionOnly } from '../../../src/shared/permissions';
import { fakeDns } from '../../unit/domain/dns-fakes';
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
	resetDomainServices();
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

	it('shows the takeover value when an unproven claim holds the name, and holds back for a proven one', async () => {
		install();
		installDomain();
		const holder = await site(OTHER_ORG, 'check-unproven-holder');
		const asker = await site(ORG, 'check-unproven-asker');
		const insert = (hostname: string, ownership: number | null, state = 'claimed') =>
			env.DB.prepare(
				`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
				provider_id, ownership_epoch, created_at, updated_at) VALUES (?, ?, ?, 'op_x', 3, ?, NULL, ?, 10, 20)`
			)
				.bind(hostname, OTHER_ORG, holder, state, ownership)
				.run();
		await insert('unproven.example.edu', null);
		await insert('stale-proof.example.edu', 2);
		await insert('proven.example.edu', 3);
		await insert('routed.example.edu', null, 'routed');
		asRole('owner');
		for (const name of ['unproven.example.edu', 'stale-proof.example.edu']) {
			const body = (await check(asker, { hostname: name })).json as CheckReply;
			expect(body.held).toBe(false);
			expect(body.records[0]!.value).toBe(await valueFor(asker, name, 4));
			expect(body.records[0]!.value).not.toBe(await valueFor(asker, name, 3));
		}
		for (const name of ['proven.example.edu', 'routed.example.edu']) {
			expect(
				await check(asker, { hostname: name }).then((reply) => reply.json)
			).toMatchObject({
				held: true,
				records: []
			});
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
		expect(reply.json).toEqual({ ready: true, enabled: false, attached: [], attach: null });
	});

	it('says whether custom domains are switched on for the platform', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-enabled');
		asRole('owner');
		installDomain({ target: TARGET });
		expect((await read(siteId)).json).toMatchObject({ ready: true, enabled: true });
		installDomain({ target: null });
		expect((await read(siteId)).json).toMatchObject({ ready: true, enabled: false });
	});

	it('gives a running attach the date it stops waiting for the ownership record, and drops it after', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-expiry');
		const waiting = await started(
			siteId,
			cursorAfter({ type: 'requested', records: [...RECORDS] })
		);
		const shown = async () =>
			((await read(siteId)).json as { attach: { expiresAt: number | null } }).attach
				.expiresAt;
		asRole('owner');
		expect(await shown()).toBe(1_000 + DEFAULT_WAIT_MS);
		await env.DB.prepare('UPDATE operations SET cursor = ? WHERE id = ?')
			.bind(
				cursorAfter({ type: 'requested', records: [...RECORDS] }, { type: 'proven' }),
				waiting
			)
			.run();
		expect(await shown()).toBeNull();
		await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
			.bind('failed', waiting)
			.run();
		expect(await shown()).toBeNull();
	});

	it('reads the age of a claim, so a hold past 72 hours can end', async () => {
		install();
		await env.DB.prepare(
			`INSERT OR REPLACE INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch,
			state, provider_id, ownership_epoch, created_at, updated_at)
			VALUES ('aged.example.edu', ?, 'site_x', 'op_x', 1, 'claimed', NULL, NULL, 10, 4242)`
		)
			.bind(ORG)
			.run();
		expect(await getClaim(await getDb(), 'aged.example.edu')).toMatchObject({
			updatedAt: 4242
		});
		await env.DB.prepare('DELETE FROM custom_domains WHERE hostname = ?')
			.bind('aged.example.edu')
			.run();
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
				{ type: 'proven' },
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

	it('tells an attach that is waiting on its proof that another site took the name', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-displaced');
		const thief = await site(OTHER_ORG, 'domain-read-displacer');
		const claim = (owner: string, org: string) =>
			env.DB.prepare(
				`INSERT OR REPLACE INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch,
				state, provider_id, ownership_epoch, created_at, updated_at)
				VALUES (?, ?, ?, 'op_x', 2, 'claimed', NULL, 2, 10, 20)`
			)
				.bind(HOST, org, owner)
				.run();
		await started(siteId, cursorAfter({ type: 'requested', records: [...RECORDS] }), 'running');
		asRole('owner');
		await claim(siteId, ORG);
		const own = ((await read(siteId)).json as { attach: Record<string, unknown> }).attach;
		expect(own).toMatchObject({ status: 'running', reason: null });
		await claim(thief, OTHER_ORG);
		const attach = ((await read(siteId)).json as { attach: { status: string; reason: string } })
			.attach;
		expect(attach.status).toBe('failed');
		expect(attach.reason).toMatch(/proved ownership of this name/);
		expect(JSON.stringify(attach)).not.toMatch(new RegExp(`${thief}|${OTHER_ORG}`));
		await env.DB.prepare('DELETE FROM custom_domains WHERE hostname = ?').bind(HOST).run();
	});

	it('does not call an attach displaced before it claimed the name or once it proved', async () => {
		install();
		const siteId = await site(ORG, 'domain-read-undisplaced');
		const thief = await site(OTHER_ORG, 'domain-read-undisplacer');
		await env.DB.prepare(
			`INSERT OR REPLACE INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch,
			state, provider_id, ownership_epoch, created_at, updated_at)
			VALUES (?, ?, ?, 'op_x', 2, 'claimed', NULL, 2, 10, 20)`
		)
			.bind(HOST, OTHER_ORG, thief)
			.run();
		await started(siteId, null, 'planned');
		asRole('owner');
		expect(
			((await read(siteId)).json as { attach: { reason: null } }).attach.reason
		).toBeNull();
		await env.DB.prepare('DELETE FROM operations WHERE site_id = ? AND type = ?')
			.bind(siteId, 'domain.attach')
			.run();
		await started(
			siteId,
			cursorAfter({ type: 'requested', records: [...RECORDS] }, { type: 'proven' })
		);
		const attach = ((await read(siteId)).json as { attach: { status: string } }).attach;
		expect(attach.status).toBe('running');
		await env.DB.prepare('DELETE FROM custom_domains WHERE hostname = ?').bind(HOST).run();
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

// #region the check route

const CHECK = '/api/v1/orgs/:orgId/sites/:id/domain/check';
const TARGET = 'edge.example.net';
const KEK = 'Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc';

async function keysOf() {
	return loadChallengeKeys({ KEK_V1: KEK });
}

function installDomain(over: { target?: string | null; keys?: () => Promise<never> } = {}) {
	const dns = fakeDns();
	setDomainServices({
		keys: over.keys ?? (async () => keysOf()),
		resolver: dns.resolver,
		target: over.target === undefined ? TARGET : over.target
	});
	return dns;
}

const check = (siteId: string, json: unknown = BODY, headers: Record<string, string> = asUser) =>
	send(domainCheck, CHECK, {
		method: 'POST',
		path: `${path(siteId)}/check`,
		headers,
		json
	});

interface CheckReply {
	hostname: string;
	apex: boolean;
	held: boolean;
	routingKnown: boolean;
	unknown: boolean;
	records: {
		purpose: string;
		type: string;
		name: string;
		value: string;
		status: string;
		found: string[];
		statusText: string;
		note?: string;
	}[];
	hazards: { code: string; text: string }[];
}

const valueFor = async (siteId: string, host = HOST, epoch = 1) =>
	(await deriveChallenge(await keysOf(), { siteId, hostname: host, epoch })).value;

describe('who may use the check route', () => {
	it('gives owners and admins the action, marks it session only and refuses a key', async () => {
		expect(ACTION_DEFS['site.domain.check'].org).toEqual(['owner', 'admin']);
		expect(ACTION_DEFS['site.domain.check'].site).toEqual(['site-admin']);
		expect(isSessionOnly('site.domain.check')).toBe(true);
		expect(ACTION_DEFS['site.domain.check']).not.toHaveProperty('stepUp');
		install();
		installDomain();
		const siteId = await site(ORG, 'check-key-site');
		const { denials } = setup({
			facts: () => ({
				...facts({ ...member('owner'), ...fresh }),
				key: { id: 'key-1', scopes: ['site.domain.check'] }
			})
		});
		expect((await check(siteId, BODY, asKey)).status).toBe(403);
		expect(denials.map((denial) => denial.reason)).toEqual(['session_only']);
	});

	it('refuses a viewer and a developer, and lets an owner check without a step-up', async () => {
		install();
		installDomain();
		const siteId = await site(ORG, 'check-roles-site');
		for (const role of ['viewer', 'developer'] as const) {
			asRole(role);
			expect((await check(siteId)).status).toBe(403);
		}
		asRole('owner', { stepUp: false });
		expect((await check(siteId)).status).toBe(200);
	});

	it('answers 404 for a site of another organisation', async () => {
		install();
		installDomain();
		const siteId = await site(OTHER_ORG, 'check-foreign-site');
		asRole('owner');
		expect((await check(siteId)).status).toBe(404);
	});
});

describe('POST a check', () => {
	it('lists the ownership and routing records before anything starts, and writes nothing', async () => {
		const { started: sent } = install();
		const dns = installDomain();
		const siteId = await site(ORG, 'check-list-site');
		sent.length = 0;
		asRole('owner');
		const before = await operationRows(siteId);
		const reply = await check(siteId, { hostname: 'WWW.Example.EDU' });
		expect(reply.status).toBe(200);
		const body = reply.json as CheckReply;
		expect(body).toMatchObject({
			hostname: HOST,
			apex: false,
			held: false,
			routingKnown: true,
			unknown: false,
			hazards: []
		});
		expect(
			body.records.map((record) => `${record.purpose}:${record.type}:${record.status}`)
		).toEqual(['ownership:TXT:missing', 'traffic:CNAME:missing']);
		expect(body.records[0]).toMatchObject({
			name: `_drupflare-challenge.${HOST}`,
			value: await valueFor(siteId),
			found: []
		});
		expect(body.records[1]).toMatchObject({ name: HOST, value: TARGET });
		expect(body.records.every((record) => record.statusText.length > 0)).toBe(true);
		expect(sent).toHaveLength(0);
		expect(await operationRows(siteId)).toEqual(before);
		expect(dns.asked.length).toBeGreaterThan(0);
	});

	it('marks each record from live DNS and shows the value found when it differs', async () => {
		install();
		const dns = installDomain();
		const siteId = await site(ORG, 'check-status-site');
		dns.put('TXT', `_drupflare-challenge.${HOST}`, `"${await valueFor(siteId, HOST, 2)}"`);
		dns.put('CNAME', HOST, 'other.example.net.');
		asRole('owner');
		const body = (await check(siteId)).json as CheckReply;
		const [owned, routed] = body.records;
		expect(owned).toMatchObject({ status: 'wrong' });
		expect(owned!.found).toEqual([await valueFor(siteId, HOST, 2)]);
		expect(routed).toMatchObject({ status: 'wrong', found: ['other.example.net'] });
		expect(body.hazards.map((hazard) => hazard.code)).toEqual(['conflicting_records']);
		dns.put('TXT', `_drupflare-challenge.${HOST}`, `"${await valueFor(siteId)}"`);
		dns.put('CNAME', HOST, `${TARGET}.`);
		const after = (await check(siteId)).json as CheckReply;
		expect(after.records.map((record) => record.status)).toEqual(['ok', 'ok']);
		expect(after.hazards).toEqual([]);
	});

	it('reports a resolver that fails as unknown and never as missing', async () => {
		install();
		const dns = installDomain();
		const siteId = await site(ORG, 'check-outage-site');
		dns.outage(true);
		asRole('owner');
		const body = (await check(siteId)).json as CheckReply;
		expect(body.unknown).toBe(true);
		expect(body.records.map((record) => record.status)).toEqual(['unknown', 'unknown']);
	});

	it('lists the ownership record alone, with routing unknown, while custom domains are off', async () => {
		install();
		installDomain({ target: null });
		const siteId = await site(ORG, 'check-off-site');
		asRole('owner');
		const body = (await check(siteId)).json as CheckReply;
		expect(body.routingKnown).toBe(false);
		expect(body.records.map((record) => record.purpose)).toEqual(['ownership']);
	});

	it('notes the alias a bare domain needs and flags an alias record already there', async () => {
		install();
		const dns = installDomain();
		const siteId = await site(ORG, 'check-apex-site');
		dns.put('CNAME', 'example.edu', 'old.example.net.');
		asRole('owner');
		const body = (await check(siteId, { hostname: 'example.edu' })).json as CheckReply;
		expect(body.apex).toBe(true);
		expect(body.records[1]!.note).toMatch(/\S/);
		expect(body.hazards.map((hazard) => hazard.code)).toEqual(
			expect.arrayContaining(['apex_cname'])
		);
	});

	it('warns when a CAA record excludes the certificate authorities', async () => {
		install();
		const dns = installDomain();
		const siteId = await site(ORG, 'check-caa-site');
		dns.put('CAA', 'example.edu', '0 issue "digicert.com"');
		asRole('owner');
		const body = (await check(siteId)).json as CheckReply;
		expect(body.hazards.map((hazard) => hazard.code)).toEqual(['caa_blocks']);
		expect(body.hazards[0]!.text).toContain('digicert.com');
	});

	it('warns about a second ownership value left at the name', async () => {
		install();
		const dns = installDomain();
		const siteId = await site(ORG, 'check-second-site');
		dns.put(
			'TXT',
			`_drupflare-challenge.${HOST}`,
			`"${await valueFor(siteId)}"`,
			'"drupflare-verify=OLDOLDOLD"'
		);
		asRole('owner');
		const body = (await check(siteId)).json as CheckReply;
		expect(body.records[0]!.status).toBe('ok');
		expect(body.hazards.map((hazard) => hazard.code)).toEqual(['second_challenge']);
	});

	it('says another live site holds the name and lists no records', async () => {
		install();
		installDomain();
		const taken = 'taken.example.edu';
		const holder = await site(ORG, 'check-holder-site');
		const asker = await site(ORG, 'check-asker-site');
		await env.DB.prepare(
			`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
			provider_id, created_at, updated_at) VALUES (?, ?, ?, 'op_x', 1, 'routed', NULL, 10, 20)`
		)
			.bind(taken, ORG, holder)
			.run();
		asRole('owner');
		const body = (await check(asker, { hostname: taken })).json as CheckReply;
		expect(body).toMatchObject({ held: true, records: [], hazards: [], unknown: false });
		expect(((await check(holder, { hostname: taken })).json as CheckReply).held).toBe(false);
	});

	it('derives the value from the epoch a new claim would carry', async () => {
		install();
		installDomain();
		const siteId = await site(ORG, 'check-epoch-site');
		const reused = 'reused.example.edu';
		await env.DB.prepare(
			`INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch, state,
			provider_id, created_at, updated_at) VALUES (?, ?, ?, 'op_x', 4, 'released', NULL, 10, 20)`
		)
			.bind(reused, ORG, siteId)
			.run();
		asRole('owner');
		const body = (await check(siteId, { hostname: reused })).json as CheckReply;
		expect(body.records[0]!.value).toBe(await valueFor(siteId, reused, 5));
		expect(body.records[0]!.value).not.toBe(await valueFor(siteId, reused, 4));
	});

	it.each([
		['www.drupflare.app', 'platform_zone'],
		['drupflare.com', 'platform_zone'],
		['*.example.edu', 'wildcard'],
		['localhost', 'invalid'],
		['10.0.0.1', 'invalid']
	])('answers 422 for %s', async (hostname, reason) => {
		install();
		installDomain();
		const siteId = await site(ORG, `check-refuse-${++counter}`);
		asRole('owner');
		const reply = await check(siteId, { hostname });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason } });
	});

	it('answers 422 for a site that is not a live managed site', async () => {
		install();
		installDomain();
		const selfManaged = await site(ORG, 'check-selfmanaged-site', 'self-managed');
		asRole('owner');
		const reply = await check(selfManaged);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'site_not_live' } });
	});

	it('rejects a bad body', async () => {
		install();
		installDomain();
		const siteId = await site(ORG, 'check-body-site');
		asRole('owner');
		for (const json of [
			{},
			{ hostname: '' },
			{ hostname: HOST, extra: true },
			{ hostname: 3 }
		]) {
			expect((await check(siteId, json)).status).toBe(400);
		}
	});

	it('answers 501 when the services are not installed or the key ring is missing', async () => {
		install();
		const siteId = await site(ORG, 'check-unbuilt-site');
		asRole('owner');
		expect((await check(siteId)).status).toBe(501);
		installDomain({
			keys: async () => {
				throw new ApiError('not_built', 'Domain checks are not available yet');
			}
		});
		expect((await check(siteId)).status).toBe(501);
	});

	it('leaves the start route as it was', async () => {
		const { started: sent } = install();
		installDomain();
		const siteId = await site(ORG, 'check-start-site');
		sent.length = 0;
		asRole('owner');
		await check(siteId);
		const reply = await start(siteId);
		expect(reply.status).toBe(202);
		expect(sent).toHaveLength(1);
	});
});

// #endregion

// #region the release route

const RELEASE = '/api/v1/orgs/:orgId/sites/:id/domain/release';

const release = (
	siteId: string,
	json: unknown = BODY,
	headers: Record<string, string> = asUser,
	orgId = ORG
) =>
	send(domainRelease, RELEASE, {
		method: 'POST',
		path: `/api/v1/orgs/${orgId}/sites/${siteId}/domain/release`,
		headers,
		json
	});

const claimRow = (hostname = HOST) =>
	env.DB.prepare(
		'SELECT site_id, state, provider_id, ownership_epoch FROM custom_domains WHERE hostname = ?'
	)
		.bind(hostname)
		.first<{
			site_id: string;
			state: string;
			provider_id: string | null;
			ownership_epoch: number | null;
		}>();

function claim(
	siteId: string,
	over: { state?: string; provider?: string | null; ownership?: number | null; org?: string } = {}
) {
	return env.DB.prepare(
		`INSERT OR REPLACE INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch,
		state, provider_id, ownership_epoch, created_at, updated_at)
		VALUES (?, ?, ?, 'op_x', 2, ?, ?, ?, 10, 20)`
	)
		.bind(
			HOST,
			over.org ?? ORG,
			siteId,
			over.state ?? 'claimed',
			over.provider ?? null,
			over.ownership === undefined ? null : over.ownership
		)
		.run();
}

const forget = () =>
	env.DB.prepare('DELETE FROM custom_domains WHERE hostname = ?').bind(HOST).run();

describe('who may use the release route', () => {
	it('gives owners and admins the site action that needs a step-up, and refuses a viewer and a developer', async () => {
		install();
		const siteId = await site(ORG, 'release-roles-site');
		await claim(siteId);
		for (const role of ['viewer', 'developer'] as const) {
			asRole(role);
			expect((await release(siteId)).status).toBe(403);
		}
		expect(await claimRow()).toMatchObject({ state: 'claimed' });
		asRole('owner', { stepUp: false });
		const stale = await release(siteId);
		expect(stale.status).toBe(403);
		expect(stale.json).toMatchObject({ details: { requires: 'step-up' } });
		expect(await claimRow()).toMatchObject({ state: 'claimed' });
		await forget();
	});

	it('refuses a key, whatever its scopes', async () => {
		install();
		const siteId = await site(ORG, 'release-key-site');
		await claim(siteId);
		const { denials } = setup({
			facts: () => ({
				...facts({ ...member('owner'), ...fresh }),
				key: { id: 'key-1', scopes: ['site.domain.manage'] }
			})
		});
		expect((await release(siteId, BODY, asKey)).status).toBe(403);
		expect(denials.map((denial) => denial.reason)).toEqual(['session_only']);
		expect(await claimRow()).toMatchObject({ state: 'claimed' });
		await forget();
	});
});

describe('POST a release', () => {
	it('gives up a claim that waits for its record, and a repeat answers the same without a change', async () => {
		install();
		const siteId = await site(ORG, 'release-waiting-site');
		await claim(siteId, { ownership: null });
		asRole('owner');
		const first = await release(siteId);
		expect(first.status).toBe(200);
		expect(first.json).toEqual({ hostname: HOST, released: true });
		expect(await claimRow()).toMatchObject({
			state: 'released',
			provider_id: null,
			ownership_epoch: null
		});
		const again = await release(siteId);
		expect(again.status).toBe(200);
		expect(again.json).toEqual({ hostname: HOST, released: false });
		await forget();
	});

	it('gives up a verified name that is parked, since no provider hostname exists for it', async () => {
		install();
		const siteId = await site(ORG, 'release-parked-site');
		await claim(siteId, { ownership: 2 });
		asRole('owner');
		expect((await release(siteId)).json).toEqual({ hostname: HOST, released: true });
		expect(await claimRow()).toMatchObject({ state: 'released', ownership_epoch: null });
		await forget();
	});

	it('lowercases the name the way the attach does', async () => {
		install();
		const siteId = await site(ORG, 'release-case-site');
		await claim(siteId);
		asRole('owner');
		expect((await release(siteId, { hostname: 'WWW.Example.EDU' })).json).toEqual({
			hostname: HOST,
			released: true
		});
		await forget();
	});

	it('refuses a name the provider already holds or that is routed, and leaves the claim', async () => {
		install();
		const siteId = await site(ORG, 'release-set-up-site');
		asRole('owner');
		for (const over of [
			{ state: 'claimed', provider: 'cf_1' },
			{ state: 'routed', provider: 'cf_1' },
			{ state: 'routed', provider: null }
		]) {
			await claim(siteId, { ...over, ownership: 2 });
			const reply = await release(siteId);
			expect(reply.status).toBe(409);
			expect(reply.json).toMatchObject({ details: { reason: 'domain_in_use' } });
			expect(await claimRow()).toMatchObject({ state: over.state, ownership_epoch: 2 });
			await forget();
		}
	});

	it('does not touch, or admit that it exists, a name another site holds', async () => {
		install();
		const siteId = await site(ORG, 'release-mine-site');
		const other = await site(OTHER_ORG, 'release-theirs-site');
		await claim(other, { org: OTHER_ORG });
		asRole('owner');
		const reply = await release(siteId);
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ hostname: HOST, released: false });
		expect(await claimRow()).toMatchObject({ site_id: other, state: 'claimed' });
		await forget();
	});

	it('does not touch a claim of the same site number held by another organisation', async () => {
		install();
		const siteId = await site(ORG, 'release-org-site');
		await claim(siteId, { org: OTHER_ORG });
		asRole('owner');
		expect((await release(siteId)).json).toEqual({ hostname: HOST, released: false });
		expect(await claimRow()).toMatchObject({ state: 'claimed' });
		await forget();
	});

	it('stops a running attach at once on the page and keeps the others reading as before', async () => {
		install();
		const siteId = await site(ORG, 'release-running-site');
		await started(siteId, cursorAfter({ type: 'requested', records: [...RECORDS] }));
		await claim(siteId);
		asRole('owner');
		const attach = async () =>
			(
				(await read(siteId)).json as {
					attach: { status: string; reason: string | null; expiresAt: number | null };
				}
			).attach;
		expect(await attach()).toMatchObject({ status: 'running', reason: null });
		await release(siteId);
		expect(await attach()).toEqual(
			expect.objectContaining({
				status: 'failed',
				reason: 'You cancelled this attach, so the name is no longer reserved for this site.',
				expiresAt: null
			})
		);
		await forget();
	});

	it('shows a parked attach as stopped once its name is given up', async () => {
		install();
		const siteId = await site(ORG, 'release-parked-view-site');
		await started(
			siteId,
			JSON.stringify({
				...JSON.parse(
					cursorAfter({ type: 'requested', records: [...RECORDS] }, { type: 'proven' })
				),
				waiting: 'custom_domains_off'
			}),
			'succeeded'
		);
		await claim(siteId, { ownership: 2 });
		asRole('owner');
		const status = async () =>
			((await read(siteId)).json as { attach: { status: string } }).attach.status;
		expect(await status()).toBe('waiting');
		await release(siteId);
		expect(await status()).toBe('failed');
		await forget();
	});

	it.each([
		['www.drupflare.app', 'platform_zone'],
		['*.example.edu', 'wildcard'],
		['localhost', 'invalid']
	])('answers 422 for %s and releases nothing', async (hostname, reason) => {
		install();
		const siteId = await site(ORG, `release-refuse-${++counter}`);
		asRole('owner');
		const reply = await release(siteId, { hostname });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason } });
	});

	it('answers 404 for a site of another organisation and rejects a bad body', async () => {
		install();
		const foreign = await site(OTHER_ORG, 'release-foreign-site');
		const own = await site(ORG, 'release-body-site');
		asRole('owner');
		expect((await release(foreign)).status).toBe(404);
		expect([400, 422]).toContain((await release(own, {})).status);
		expect([400, 422]).toContain((await release(own, { hostname: HOST, extra: 1 })).status);
	});
});

// #endregion
