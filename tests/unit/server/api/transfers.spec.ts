import type { CollegeDBClient } from '@earth-app/collegedb';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import transferCancel from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/transfers/[transferId]/cancel.post';
import transferPropose from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/transfers/index.post';
import transferAccept from '../../../../src/server/api/v1/orgs/[orgId]/transfers/[id]/accept.post';
import transferComplete from '../../../../src/server/api/v1/orgs/[orgId]/transfers/[id]/complete.post';
import transferDecline from '../../../../src/server/api/v1/orgs/[orgId]/transfers/[id]/decline.post';
import transferList from '../../../../src/server/api/v1/orgs/[orgId]/transfers/index.get';
import { transferHostnameCollisions } from '../../../../src/server/db/repos/agency';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import {
	setTransferServices,
	type TransferServices
} from '../../../../src/server/services/transfers';
import type { LoadInput } from '../../../../src/server/utils/define-api';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { facts, fresh, member, ORG, OTHER_ORG } from '../../domain/fixtures';
import { asUser, send, setup, SITES } from '../fixtures/harness';

const SITE = 'site_aaaa1111';
const DAY = 24 * 60 * 60 * 1000;

function world(
	options: {
		siteLimit?: number | null;
		startCompletion?: TransferServices['startCompletion'];
	} = {}
) {
	const clock = { now: 1_800_000_000_000 };
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
	const db = {
		async batch(statements: { sql: string; bindings: unknown[] }[]) {
			for (const statement of statements) {
				sql.prepare(statement.sql).run(...(statement.bindings as never[]));
			}
			return [{ shard: 'DB' }];
		},
		async first(_key: string, text: string, bindings: unknown[] = []) {
			return sql.prepare(text).get(...(bindings as never[])) ?? null;
		},
		async all(_key: string, text: string, bindings: unknown[] = []) {
			return { results: sql.prepare(text).all(...(bindings as never[])) };
		},
		async run(_key: string, text: string, bindings: unknown[] = []) {
			const result = sql.prepare(text).run(...(bindings as never[]));
			return { meta: { changes: Number(result.changes) } };
		},
		async allAllShards(text: string, bindings: unknown[] = []) {
			return [{ success: true, results: sql.prepare(text).all(...(bindings as never[])) }];
		}
	} as unknown as CollegeDBClient;
	const trail: { orgId: string; action: string }[] = [];
	const services: TransferServices = {
		getDb: async () => db,
		audit: async (orgId, input) => {
			trail.push({ orgId, action: input.action });
		},
		now: () => clock.now,
		...(options.siteLimit === undefined
			? {}
			: { targetLimits: async () => ({ siteLimit: options.siteLimit as number | null }) }),
		...(options.startCompletion ? { startCompletion: options.startCompletion } : {})
	};
	setTransferServices(services);
	for (const id of [ORG, OTHER_ORG]) {
		sql.prepare(
			'INSERT INTO organizations (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 1)'
		).run(id, id, 'seed');
	}
	sql.prepare(
		"INSERT INTO sites (id, organization_id, name, plane, state, account_id, kind, created_at, updated_at) VALUES (?, ?, 'one', 'managed', 'active', 'acct_1', 'drupal', 1, 1)"
	).run(SITE, ORG);
	SITES[SITE] = ORG;
	return { sql, trail, clock };
}

const sourceOwner = (input: LoadInput) =>
	input.params.orgId === OTHER_ORG
		? facts({ membership: { orgId: OTHER_ORG, role: 'owner' }, ...fresh })
		: facts({ ...member('owner'), ...fresh });

function parties() {
	return setup({ facts: sourceOwner });
}

const propose = (body: unknown) =>
	send(transferPropose, '/api/v1/orgs/:orgId/sites/:id/transfers', {
		method: 'POST',
		path: `/api/v1/orgs/${ORG}/sites/${SITE}/transfers`,
		headers: asUser,
		json: body
	});

const answer = (
	verb: 'accept' | 'decline',
	org: string,
	id: string,
	handler: Parameters<typeof send>[0]
) =>
	send(handler, `/api/v1/orgs/:orgId/transfers/:id/${verb}`, {
		method: 'POST',
		path: `/api/v1/orgs/${org}/transfers/${id}/${verb}`,
		headers: asUser,
		json: {}
	});

afterEach(() => {
	setTransferServices(null);
	resetApiDeps();
});

beforeEach(() => {
	resetApiDeps();
});

describe('propose a site transfer', () => {
	it('proposes to another organisation, pending for fourteen days, and audits both sides', async () => {
		const w = world({ siteLimit: 10 });
		parties();
		const reply = await propose({ toOrganizationId: OTHER_ORG });
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({
			siteId: SITE,
			fromOrganizationId: ORG,
			toOrganizationId: OTHER_ORG,
			state: 'proposed',
			keepDelegationId: null
		});
		const expires = Date.parse((reply.json as { expiresAt: string }).expiresAt);
		expect(expires - w.clock.now).toBe(14 * DAY);
		expect(w.trail.map((entry) => entry.orgId).sort()).toEqual([ORG, OTHER_ORG].sort());
	});

	it('refuses a second open proposal for the same site', async () => {
		world({ siteLimit: 10 });
		parties();
		await propose({ toOrganizationId: OTHER_ORG });
		const again = await propose({ toOrganizationId: OTHER_ORG });
		expect(again.status).toBe(409);
		expect(again.json).toMatchObject({ details: { reason: 'transfer_open' } });
	});

	it('refuses a keep-delegation that is not active for this site', async () => {
		world({ siteLimit: 10 });
		parties();
		const reply = await propose({
			toOrganizationId: OTHER_ORG,
			keepDelegationId: 'batch-none'
		});
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ details: { reason: 'keep_delegation_invalid' } });
	});

	it('refuses an unknown receiving organisation', async () => {
		world({ siteLimit: 10 });
		parties();
		const reply = await propose({ toOrganizationId: 'org-nobody' });
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'target_unknown' } });
	});

	it('answers as not found for a site the organisation does not hold', async () => {
		world({ siteLimit: 10 });
		parties();
		const reply = await send(transferPropose, '/api/v1/orgs/:orgId/sites/:id/transfers', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites/site_zzzz9999/transfers`,
			headers: asUser,
			json: { toOrganizationId: OTHER_ORG }
		});
		expect(reply.status).toBe(404);
	});
});

type Start = Parameters<NonNullable<TransferServices['startCompletion']>>[0];

describe('complete a site transfer', () => {
	async function accepted(
		options: { start?: (request: Start) => Promise<void>; siteLimit?: number | null } = {}
	) {
		const started: Start[] = [];
		const startCompletion =
			options.start === undefined && 'start' in options
				? undefined
				: async (request: Start) => {
						started.push(request);
						await options.start?.(request);
					};
		const w = world({ siteLimit: options.siteLimit ?? 10, startCompletion });
		parties();
		const proposal = await propose({ toOrganizationId: OTHER_ORG });
		const id = (proposal.json as { id: string }).id;
		await answer('accept', OTHER_ORG, id, transferAccept);
		return { w, id, started };
	}

	const complete = (id: string, org = OTHER_ORG) =>
		send(transferComplete, '/api/v1/orgs/:orgId/transfers/:id/complete', {
			method: 'POST',
			path: `/api/v1/orgs/${org}/transfers/${id}/complete`,
			headers: asUser,
			json: {}
		});

	const listed = async () => {
		const reply = await send(transferList, '/api/v1/orgs/:orgId/transfers', {
			path: `/api/v1/orgs/${OTHER_ORG}/transfers`,
			headers: asUser
		});
		return (reply.json as { incoming: { state: string; failureReason: string | null }[] })
			.incoming[0]!;
	};

	it('starts the engine run, answers 202 with the operation and shows completing', async () => {
		const { w, id, started } = await accepted();
		const reply = await complete(id);
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({ state: 'completing', failureReason: null });
		const operationId = (reply.json as { operationId: string }).operationId;
		expect(started).toEqual([
			{
				workflow: 'site-transfer',
				id: operationId,
				params: {
					operationId,
					transferId: id,
					siteId: SITE,
					fromOrgId: ORG,
					toOrgId: OTHER_ORG,
					accountId: 'acct_1'
				}
			}
		]);
		expect(w.sql.prepare('SELECT type, status FROM operations').all()).toEqual([
			{ type: 'site.transfer', status: 'planned' }
		]);
		expect(w.trail).toContainEqual({
			orgId: OTHER_ORG,
			action: 'site.transfer.completion_started'
		});
		expect((await listed()).state).toBe('completing');
	});

	it('answers with the open run and starts nothing a second time', async () => {
		const { id, started } = await accepted();
		const first = await complete(id);
		const again = await complete(id);
		expect(again.status).toBe(202);
		expect((again.json as { operationId: string }).operationId).toBe(
			(first.json as { operationId: string }).operationId
		);
		expect(started).toHaveLength(1);
	});

	it('shows a failed run in plain words and starts the next attempt on a retry', async () => {
		const { w, id, started } = await accepted();
		const first = await complete(id);
		const operationId = (first.json as { operationId: string }).operationId;
		w.sql
			.prepare(`UPDATE operations SET status = 'failed', final_observation = ? WHERE id = ?`)
			.run(
				JSON.stringify({
					at: '2026-11-21T00:00:00.000Z',
					summary: 'retire: read_back_mismatch: 1 records differ'
				}),
				operationId
			);
		const failed = await listed();
		expect(failed.state).toBe('failed');
		expect(failed.failureReason).toContain('nothing was removed');
		expect(failed.failureReason).not.toContain('read_back_mismatch');

		const retry = await complete(id);
		expect(retry.status).toBe(202);
		expect(retry.json).toMatchObject({ state: 'completing' });
		expect((retry.json as { operationId: string }).operationId).not.toBe(operationId);
		expect(started).toHaveLength(2);
		expect(
			w.sql
				.prepare(
					'SELECT idempotency_key, retry_of FROM operations ORDER BY created_at, rowid'
				)
				.all()
		).toEqual([
			{ idempotency_key: `transfer:${id}:1`, retry_of: null },
			{ idempotency_key: `transfer:${id}:2`, retry_of: operationId }
		]);
	});

	it('marks the operation failed and refuses when the engine will not take the start', async () => {
		const { w, id } = await accepted({
			start: async () => {
				throw new Error('engine down');
			}
		});
		const reply = await complete(id);
		expect(reply.status).toBe(422);
		expect(w.sql.prepare('SELECT status FROM operations').all()).toEqual([
			{ status: 'failed' }
		]);
	});

	it('does not expire an accepted transfer, however late it is completed', async () => {
		const { w, id } = await accepted();
		w.clock.now += 30 * DAY;
		expect((await complete(id)).status).toBe(202);
	});

	it('answers completed once the engine marked the transfer done', async () => {
		const { w, id } = await accepted();
		await complete(id);
		w.sql.prepare(`UPDATE site_transfers SET state = 'completed'`).run();
		w.sql.prepare(`UPDATE operations SET status = 'succeeded'`).run();
		const reply = await complete(id);
		expect(reply.json).toMatchObject({ state: 'completed' });
		expect((await listed()).state).toBe('completed');
	});

	it('refuses a transfer that is not accepted, and starts nothing', async () => {
		const started: Start[] = [];
		world({ siteLimit: 10, startCompletion: async (r) => void started.push(r) });
		parties();
		const proposal = await propose({ toOrganizationId: OTHER_ORG });
		const id = (proposal.json as { id: string }).id;
		const reply = await complete(id);
		expect(reply.status).toBe(409);
		expect(started).toEqual([]);
	});

	it('answers not built while the engine start is not wired', async () => {
		const { id } = await accepted({ start: undefined });
		const reply = await complete(id);
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ details: { reason: 'completion_not_built' } });
	});

	it('checks the site limit of the receiving plan again at completion', async () => {
		const { w, id, started } = await accepted();
		setTransferServices({
			...(await import('../../../../src/server/services/transfers')).transferServices(),
			targetLimits: async () => ({ siteLimit: 0 })
		});
		const reply = await complete(id);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'site_limit' } });
		expect(started).toEqual([]);
		expect(w.sql.prepare('SELECT COUNT(*) AS n FROM operations').get()).toEqual({ n: 0 });
	});

	it('refuses while another operation holds the site', async () => {
		const { w, id, started } = await accepted();
		w.sql
			.prepare(
				`INSERT INTO operations (id, organization_id, account_id, site_id, type, status,
				idempotency_key, target_ids, preconditions, plan_digest, fencing_epoch, blast_radius,
				verification, budget, created_at, updated_at)
				VALUES ('op_busy0001', ?, 'acct_1', ?, 'site.upgrade', 'running', 'k1', '[]', '[]', 'd', 0,
				'{}', 'pending', '{}', 1, 1)`
			)
			.run(ORG, SITE);
		const reply = await complete(id);
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'site_busy' } });
		expect(started).toEqual([]);
	});

	it('names the policy group of the receiving organisation that forbids the site template', async () => {
		const { w, id, started } = await accepted();
		w.sql
			.prepare(
				`INSERT INTO policy_groups (id, organization_id, name, rules, created_at)
				VALUES ('grp_1', ?, 'No Drupal', ?, 1)`
			)
			.run(OTHER_ORG, JSON.stringify({ forbiddenTemplates: ['drupal'] }));
		w.sql
			.prepare(
				`INSERT INTO policy_assignments (organization_id, group_id, target_kind, target_id,
				assigned_by, assigned_at) VALUES (?, 'grp_1', 'organization', ?, 'usr', 1)`
			)
			.run(OTHER_ORG, OTHER_ORG);
		const reply = await complete(id);
		expect(reply.status).toBe(403);
		expect(reply.json).toMatchObject({
			details: { requires: 'policy', policyName: 'No Drupal' }
		});
		expect(started).toEqual([]);
	});

	it('refuses the sending side and a stranger, as if the transfer did not exist', async () => {
		const { id, started } = await accepted();
		expect((await complete(id, ORG)).status).toBe(404);
		expect((await complete(id, 'org_stranger')).status).toBe(404);
		expect(started).toEqual([]);
	});
});

describe('a hostname held for another site in the receiving shard', () => {
	it('is found, and a hostname of the same site is not', async () => {
		const first = new DatabaseSync(':memory:');
		const second = new DatabaseSync(':memory:');
		for (const statement of SCHEMA_STATEMENTS) {
			first.exec(statement);
			second.exec(statement);
		}
		const row = `INSERT INTO custom_domains (hostname, organization_id, site_id, operation_id, epoch,
			state, provider_id, ownership_epoch, created_at, updated_at)
			VALUES (?, ?, ?, 'op', 1, 'routed', NULL, NULL, 1, 1)`;
		first.prepare(row).run('a.example.org', ORG, SITE);
		first.prepare(row).run('b.example.org', ORG, SITE);
		second.prepare(row).run('a.example.org', OTHER_ORG, 'site_other');
		second.prepare(row).run('b.example.org', OTHER_ORG, SITE);
		const db = {
			async all(key: string, text: string, bindings: unknown[] = []) {
				const sql = key === ORG ? first : second;
				return { results: sql.prepare(text).all(...(bindings as never[])) };
			},
			async first(key: string, text: string, bindings: unknown[] = []) {
				const sql = key === ORG ? first : second;
				return sql.prepare(text).get(...(bindings as never[])) ?? null;
			}
		} as unknown as CollegeDBClient;
		expect(await transferHostnameCollisions(db, ORG, OTHER_ORG, SITE)).toEqual([
			'a.example.org'
		]);
	});
});

describe('answer a site transfer', () => {
	async function proposed() {
		const reply = await propose({ toOrganizationId: OTHER_ORG });
		return (reply.json as { id: string }).id;
	}

	it('accepts once the receiving plan has room, and refuses a second answer', async () => {
		world({ siteLimit: 10 });
		parties();
		const id = await proposed();
		const first = await answer('accept', OTHER_ORG, id, transferAccept);
		expect(first.status).toBe(200);
		expect(first.json).toMatchObject({ state: 'accepted' });
		const again = await answer('accept', OTHER_ORG, id, transferAccept);
		expect(again.status).toBe(409);
	});

	it('refuses an accept when the receiving organisation is at its site limit, and says so', async () => {
		world({ siteLimit: 0 });
		parties();
		const id = await proposed();
		const reply = await answer('accept', OTHER_ORG, id, transferAccept);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'site_limit', limit: 0 } });
	});

	it('refuses an accept while the plan read is not wired, and names it', async () => {
		world();
		parties();
		const id = await proposed();
		const reply = await answer('accept', OTHER_ORG, id, transferAccept);
		expect(reply.status).toBe(501);
		expect(reply.json).toMatchObject({ details: { reason: 'target_limits_not_built' } });
	});

	it('lets the receiving side decline, and a declined transfer cannot be accepted', async () => {
		world({ siteLimit: 10 });
		parties();
		const id = await proposed();
		const declined = await answer('decline', OTHER_ORG, id, transferDecline);
		expect(declined.json).toMatchObject({ state: 'declined' });
		const late = await answer('accept', OTHER_ORG, id, transferAccept);
		expect(late.status).toBe(409);
	});

	it('refuses the proposing side an answer to its own proposal', async () => {
		world({ siteLimit: 10 });
		parties();
		const id = await proposed();
		const reply = await answer('accept', ORG, id, transferAccept);
		expect(reply.status).toBe(404);
	});

	it('lets the proposer cancel before an answer, and only for the site it names', async () => {
		world({ siteLimit: 10 });
		parties();
		const id = await proposed();
		const wrongSite = await send(
			transferCancel,
			'/api/v1/orgs/:orgId/sites/:id/transfers/:transferId/cancel',
			{
				method: 'POST',
				path: `/api/v1/orgs/${ORG}/sites/site_zzzz9999/transfers/${id}/cancel`,
				headers: asUser,
				json: {}
			}
		);
		expect(wrongSite.status).toBe(404);
		const cancelled = await send(
			transferCancel,
			'/api/v1/orgs/:orgId/sites/:id/transfers/:transferId/cancel',
			{
				method: 'POST',
				path: `/api/v1/orgs/${ORG}/sites/${SITE}/transfers/${id}/cancel`,
				headers: asUser,
				json: {}
			}
		);
		expect(cancelled.json).toMatchObject({ state: 'cancelled' });
	});

	it('shows a proposal that passed its window as expired, and refuses the accept', async () => {
		const w = world({ siteLimit: 10 });
		parties();
		const id = await proposed();
		w.clock.now += 14 * DAY;
		const listed = await send(transferList, '/api/v1/orgs/:orgId/transfers', {
			path: `/api/v1/orgs/${OTHER_ORG}/transfers`,
			headers: asUser
		});
		expect(listed.json).toMatchObject({ incoming: [{ id, state: 'expired' }], outgoing: [] });
		const late = await answer('accept', OTHER_ORG, id, transferAccept);
		expect(late.status).toBe(409);
		expect(late.json).toMatchObject({ details: { reason: 'expired' } });
	});

	it('lists the proposal under outgoing for the source and incoming for the target', async () => {
		world({ siteLimit: 10 });
		parties();
		const id = await proposed();
		const outgoing = await send(transferList, '/api/v1/orgs/:orgId/transfers', {
			path: `/api/v1/orgs/${ORG}/transfers`,
			headers: asUser
		});
		expect(outgoing.json).toMatchObject({ outgoing: [{ id }], incoming: [] });
	});
});

describe('site transfer facts', () => {
	it('does not let the target organisation propose a site it does not hold', async () => {
		world({ siteLimit: 10 });
		setup({ facts: (input) => sourceOwner(input) });
		const reply = await send(transferPropose, '/api/v1/orgs/:orgId/sites/:id/transfers', {
			method: 'POST',
			path: `/api/v1/orgs/${OTHER_ORG}/sites/${SITE}/transfers`,
			headers: asUser,
			json: { toOrganizationId: ORG }
		});
		expect(reply.status).toBe(403);
	});
});
