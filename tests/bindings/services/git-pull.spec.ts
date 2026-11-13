import type { D1Database } from '@cloudflare/workers-types';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { toBase64Url } from '../../../contracts/src/common';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getOperationInputs } from '../../../src/server/db/repos/operations';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import { hmacSha256Hex } from '../../../src/server/services/crypto';
import { startGitPull } from '../../../src/server/services/git-pull';
import {
	acceptDelivery,
	collegeRepoStore,
	listRemotes,
	pullNow,
	type RepoConnectionDeps
} from '../../../src/server/services/repo-connections';
import { collegeOnceStore } from '../../../src/server/services/single-use';
import type { SiteServices } from '../../../src/server/services/sites';
import { loadKeyRing } from '../../../src/shared/custody/envelope';
import { ApiError } from '../../../src/shared/errors';
import { ORG } from '../../unit/domain/fixtures';
import { openBindings, type Bindings, type OpenBindings } from '../support';

const ACCOUNT = 'a'.repeat(32);
const SITE = `site_${'a'.repeat(20)}`;
const DEAD = `site_${'d'.repeat(20)}`;
const CONNECTION = 'conn_git_1';
const REMOTE = 'rem_git_1';
const OTHER_REMOTE = 'rem_git_2';
const SECRET = 'hook-secret';
const NOW = 1_790_000_000_000;

let harness: OpenBindings;
let env: Bindings;
const db = () => env.DB as D1Database;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));
let started: EngineStartRequest[];
let startFails = false;

const services = (): SiteServices =>
	({
		getDb,
		startOperation: async (request: EngineStartRequest) => {
			if (startFails) throw new Error('the engine is down');
			started.push(request);
		}
	}) as unknown as SiteServices;

async function deps(): Promise<RepoConnectionDeps> {
	const ring = await loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(32).fill(3)) });
	const base = services();
	return {
		store: collegeRepoStore(getDb),
		once: collegeOnceStore(getDb),
		ring: async () => ring,
		fetch: async () => new Response('[]'),
		resolve: async () => [],
		now: () => NOW,
		github: {
			appId: '1',
			privateKey: '',
			slug: 'drupflare',
			clientId: 'cid',
			clientSecret: 'csecret',
			webhookSecret: SECRET
		},
		gitlab: null,
		pullRemote: (remote, trigger) => startGitPull(base, remote, trigger.key),
		audit: async () => {}
	};
}

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await getDb();
	const site = (id: string, state: string, host: string | null) =>
		db()
			.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, account_id, category, config, kind,
				primary_hostname, ready_at, created_at, updated_at)
				VALUES (?, ?, ?, 'managed', ?, ?, 'cms', 'managed', 'drupal', ?, ?, ?, ?)`
			)
			.bind(id, ORG, id, state, ACCOUNT, host, NOW, NOW, NOW)
			.run();
	await site(SITE, 'active', 'a.drupflare.app');
	await site(DEAD, 'deleted', null);
	await db()
		.prepare(
			`INSERT INTO repo_connections (id, organization_id, provider, external_id, display_name,
			credential_envelope, scopes, state, created_at, revoked_at)
			VALUES (?, ?, 'github', '42', 'GitHub installation 42', NULL, '[]', 'active', ?, NULL)`
		)
		.bind(CONNECTION, ORG, NOW)
		.run();
	for (const [id, site] of [
		[REMOTE, SITE],
		[OTHER_REMOTE, SITE]
	] as const) {
		await db()
			.prepare(
				`INSERT INTO site_remotes (id, site_id, organization_id, connection_id, repo_full_name,
				branch, mount_path, interval_minutes, last_pull_status, last_pull_at, last_pull_reason, created_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, 60, NULL, NULL, NULL, ?)`
			)
			.bind(
				id,
				site,
				ORG,
				CONNECTION,
				id === REMOTE ? 'ops/site' : 'ops/other',
				'main',
				'modules/custom/site',
				NOW
			)
			.run();
	}
});

afterAll(() => harness.close());

beforeEach(async () => {
	started = [];
	startFails = false;
	await db().prepare('DELETE FROM operation_steps').run();
	await db().prepare('DELETE FROM operations').run();
	await db().prepare('DELETE FROM repo_deliveries').run();
	await db()
		.prepare(
			'UPDATE site_remotes SET last_pull_status = NULL, last_pull_at = NULL, last_pull_reason = NULL'
		)
		.run();
});

const remoteRow = async (id = REMOTE) => {
	const [row] = (await listRemotes(await deps(), ORG, SITE)).filter((item) => item.id === id);
	return row;
};

const asRow = async (id = REMOTE) => {
	const store = collegeRepoStore(getDb);
	return (await store.listRemotes(ORG, SITE)).find((row) => row.id === id)!;
};

async function refused(work: () => Promise<unknown>): Promise<ApiError> {
	try {
		await work();
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('expected a refusal');
}

describe('startGitPull', () => {
	it('records a planned git.pull with the remote id and starts the pull workflow', async () => {
		const remote = await asRow();
		const { operation } = await startGitPull(services(), remote, 'press-1');
		expect(operation).toMatchObject({
			type: 'git.pull',
			status: 'planned',
			targetIds: [SITE],
			idempotencyKey: 'press-1',
			verification: 'pending'
		});
		expect(operation.steps.map((step) => step.id)).toEqual(['lease', 'find', 'pull', 'record']);
		expect(operation.blastRadius).toEqual({
			sites: 1,
			destructiveSites: 0,
			productionDeploys: 0
		});
		expect(await getOperationInputs(await getDb(), ORG, operation.id)).toEqual({
			operationId: operation.id,
			orgId: ORG,
			siteId: SITE,
			accountId: ACCOUNT,
			remoteId: REMOTE
		});
		expect(started).toEqual([
			{
				workflow: 'git-pull',
				id: operation.id,
				params: expect.objectContaining({ remoteId: REMOTE, siteId: SITE })
			}
		]);
	});

	it('returns the first operation for a repeated key and starts nothing more', async () => {
		const remote = await asRow();
		const first = await startGitPull(services(), remote, 'press-2');
		const again = await startGitPull(services(), remote, 'press-2');
		expect(again.operation.id).toBe(first.operation.id);
		expect(started).toHaveLength(1);
	});

	it('refuses a key an earlier request used for another repository', async () => {
		await startGitPull(services(), await asRow(), 'press-3');
		const error = await refused(async () =>
			startGitPull(services(), await asRow(OTHER_REMOTE), 'press-3')
		);
		expect(error.details).toMatchObject({ reason: 'idempotency_key_reused' });
		expect(started).toHaveLength(1);
	});

	it('refuses while another change to the site is open', async () => {
		await startGitPull(services(), await asRow(), 'press-4');
		const error = await refused(async () =>
			startGitPull(services(), await asRow(OTHER_REMOTE), 'press-5')
		);
		expect(error.code).toBe('conflict');
		expect(error.details).toMatchObject({ reason: 'site_busy' });
		expect(started).toHaveLength(1);
	});

	it('refuses a site that is gone and a site that is not live', async () => {
		const row = await asRow();
		const gone = await refused(() =>
			startGitPull(services(), { ...row, siteId: 'site_none' }, 'k-1')
		);
		expect(gone.code).toBe('not_found');
		const dead = await refused(() => startGitPull(services(), { ...row, siteId: DEAD }, 'k-2'));
		expect(dead.code).toBe('unprocessable');
		expect(dead.details).toMatchObject({ reason: 'site_not_live' });
		expect(started).toEqual([]);
	});

	it('marks the operation failed when the engine refuses the start', async () => {
		startFails = true;
		const error = await refused(async () =>
			startGitPull(services(), await asRow(OTHER_REMOTE), 'press-6')
		);
		expect(error.message).toBe('The pull could not be started. Press Pull to try again.');
		const row = await db()
			.prepare('SELECT status FROM operations WHERE idempotency_key = ?')
			.bind('press-6')
			.first<{ status: string }>();
		expect(row?.status).toBe('failed');
	});
});

const pushBody = (repo = 'ops/site') =>
	JSON.stringify({
		ref: 'refs/heads/main',
		after: 'c'.repeat(40),
		repository: { full_name: repo },
		installation: { id: 42 }
	});

const deliver = async (body: string, deliveryId: string, signature?: string) =>
	acceptDelivery(await deps(), 'github', {
		eventName: 'push',
		deliveryId,
		rawBody: body,
		signature: signature ?? `sha256=${await hmacSha256Hex(SECRET, body)}`
	});

describe('a signed push', () => {
	it('creates one operation carrying the remote id, and a redelivery adds none', async () => {
		const body = pushBody();
		expect(await deliver(body, 'delivery-1')).toEqual({ duplicate: false, matched: 1 });
		expect(await deliver(body, 'delivery-1')).toEqual({ duplicate: true, matched: 0 });
		expect(started).toHaveLength(1);
		const [request] = started;
		expect(request?.workflow).toBe('git-pull');
		expect(request?.params).toMatchObject({ remoteId: REMOTE, siteId: SITE });
		const count = await db()
			.prepare('SELECT COUNT(*) AS n FROM operations')
			.first<{ n: number }>();
		expect(count?.n).toBe(1);
		expect((await remoteRow())?.lastPullStatus).toBeNull();
	});

	it('refuses a bad signature before any operation exists', async () => {
		const error = await refused(() => deliver(pushBody(), 'delivery-2', 'sha256=00'));
		expect(error.code).toBe('unauthenticated');
		expect(started).toEqual([]);
	});

	it('marks a second push to the same repository as pending while its pull runs', async () => {
		await deliver(pushBody('ops/site'), 'delivery-3');
		const result = await deliver(pushBody('ops/site'), 'delivery-4');
		expect(result).toEqual({ duplicate: false, matched: 1 });
		expect(started).toHaveLength(1);
		expect(await remoteRow()).toMatchObject({
			lastPullStatus: null,
			lastPullReason: null
		});
		const mark = await db()
			.prepare('SELECT pull_pending AS pending FROM site_remotes WHERE id = ?')
			.bind(REMOTE)
			.first<{ pending: number }>();
		expect(mark?.pending).toBe(1);
	});

	it('stores a plain failed reason on another repository the running pull does not cover', async () => {
		await deliver(pushBody('ops/site'), 'delivery-3');
		const result = await deliver(pushBody('ops/other'), 'delivery-4');
		expect(result).toEqual({ duplicate: false, matched: 1 });
		expect(started).toHaveLength(1);
		expect(await remoteRow(OTHER_REMOTE)).toMatchObject({
			lastPullStatus: 'failed',
			lastPullReason:
				'Another change to this site is still running. Wait for it to finish, then try again.'
		});
		const mark = await db()
			.prepare('SELECT pull_pending AS pending FROM site_remotes WHERE id = ?')
			.bind(OTHER_REMOTE)
			.first<{ pending: number }>();
		expect(mark?.pending).toBe(0);
		const delivery = await db()
			.prepare('SELECT delivery_id FROM repo_deliveries WHERE delivery_id = ?')
			.bind('delivery-4')
			.first();
		expect(delivery).not.toBeNull();
	});

	it('stores a plain failed reason when the engine will not start the pull', async () => {
		startFails = true;
		await deliver(pushBody(), 'delivery-5');
		expect(await remoteRow()).toMatchObject({
			lastPullStatus: 'failed',
			lastPullReason: 'The pull could not be started. Press Pull to try again.'
		});
	});

	it('starts the same operation for an owner press under its own key', async () => {
		const d = await deps();
		const first = await pullNow(d, {
			orgId: ORG,
			siteId: SITE,
			remoteId: REMOTE,
			idempotencyKey: 'press-9'
		});
		const again = await pullNow(d, {
			orgId: ORG,
			siteId: SITE,
			remoteId: REMOTE,
			idempotencyKey: 'press-9'
		});
		expect(again.operation.id).toBe(first.operation.id);
		expect(started).toHaveLength(1);
	});
});
