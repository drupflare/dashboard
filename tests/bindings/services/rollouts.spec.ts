import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import rolloutGet from '../../../src/server/api/v1/admin/releases/[releaseId]/rollout/index.get';
import rolloutPost from '../../../src/server/api/v1/admin/releases/[releaseId]/rollout/index.post';
import rolloutStop from '../../../src/server/api/v1/admin/releases/[releaseId]/rollout/stop.post';
import listRoute from '../../../src/server/api/v1/admin/releases/index.get';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { registerRelease } from '../../../src/server/db/repos/releases';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import { setReleaseServices } from '../../../src/server/services/releases';
import { collegeOnceStore } from '../../../src/server/services/single-use';
import { resetSiteServices, setSiteServices } from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { admin, facts, fresh } from '../../unit/domain/fixtures';
import { asUser, send, setup } from '../../unit/server/fixtures/harness';
import { type Bindings, type OpenBindings, openBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));
const digest = `sha256:${'1'.repeat(64)}`;
const ADVISORY = 1_000;
const base = '/api/v1/admin/releases';

let started: EngineStartRequest[] = [];

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	const db = await getDb();
	for (const [id, version, advisoryAt] of [
		['rel-a', '1.0.0', ADVISORY],
		['rel-b', '1.1.0', null],
		['rel-c', '1.2.0', null],
		['rel-d', '1.3.0', null]
	] as const) {
		await registerRelease(db, {
			id,
			kind: 'worker',
			version,
			manifestDigest: digest,
			schemaVersion: 1,
			acceptsSchema: 1,
			publishedAt: 1,
			advisoryAt,
			now: 1
		});
	}
	for (let n = 0; n < 4; n++) {
		await env.DB.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, account_id, primary_hostname,
				release_id, ready_at, created_at, updated_at)
			 VALUES (?, ?, ?, 'managed', 'active', ?, ?, 'old', 1, 1, 1)`
		)
			.bind(
				`site_ro${n}`,
				`org-${n % 2}`,
				`Rollout ${n}`,
				'a'.repeat(32),
				`ro${n}.drupflare.app`
			)
			.run();
	}
});

afterAll(() => harness.close());

afterEach(() => {
	resetApiDeps();
	resetSiteServices();
	setReleaseServices(null);
});

function install() {
	started = [];
	const plan = derive(FREE_PLAN_ID);
	if (!plan.ok) throw new Error(plan.reason);
	setSiteServices({
		getDb,
		planOf: async () => plan.entitlement,
		startOperation: async (request) => {
			started.push(request);
		}
	});
	setReleaseServices({
		getDb,
		once: collegeOnceStore(getDb),
		fetch: async () => new Response(''),
		resolve: async () => [],
		now: Date.now,
		hookSecret: ''
	});
}

function asAdmin(stepUp = true) {
	setup({
		deps: {
			load: async () => ({
				resource: {},
				facts: facts({ ...admin, ...(stepUp ? fresh : {}) })
			}),
			access: async () => ({ email: 'admin@example.test' })
		}
	});
}

let counter = 0;
const key = () => `ro-key-${++counter}-${Date.now()}`;

const start = (releaseId: string, body: unknown = {}, headers: Record<string, string> = {}) =>
	send(rolloutPost, `${base}/:releaseId/rollout`, {
		method: 'POST',
		path: `${base}/${releaseId}/rollout`,
		headers: { ...asUser, 'idempotency-key': key(), ...headers },
		json: body
	});

async function endRollouts() {
	await env.DB.prepare(`UPDATE release_rollouts SET status = 'complete'`).run();
}

describe('POST a rollout', () => {
	it('starts the workflow with the rings in order and the synthetic site marked', async () => {
		install();
		asAdmin();
		const reply = await start('rel-a', {
			designations: { synthetic: ['site_ro0'], own: ['site_ro1'] }
		});
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({
			releaseId: 'rel-a',
			status: 'rolling',
			currentRing: 'R0'
		});
		const request = started.find((entry) => entry.workflow === 'release-ring');
		const params = request?.params as {
			rings: { ring: string; sites: { id: string; synthetic?: boolean }[] }[];
		};
		expect(params.rings.map((entry) => entry.ring)).toEqual(['R0', 'R1', 'R4']);
		expect(params.rings[0]!.sites).toEqual([
			{ id: 'site_ro0', plan: expect.any(String), synthetic: true }
		]);
		expect(params.rings[2]!.sites.map((site) => site.id)).toEqual(['site_ro2', 'site_ro3']);
		const row = await env.DB.prepare(
			`SELECT status, stop_requested FROM release_rollouts`
		).first();
		expect(row).toMatchObject({ status: 'rolling', stop_requested: 0 });
	});

	it('refuses a second rollout while one runs', async () => {
		install();
		asAdmin();
		const reply = await start('rel-b');
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'rollout_running' } });
		expect(started).toEqual([]);
		await endRollouts();
	});

	it('leaves a site that already runs the release out of the rings', async () => {
		install();
		asAdmin();
		await env.DB.prepare(`UPDATE sites SET release_id = 'rel-b' WHERE id = 'site_ro3'`).run();
		const reply = await start('rel-b');
		expect(reply.status).toBe(202);
		const params = started[0]!.params as { rings: { sites: { id: string }[] }[] };
		expect(params.rings.flatMap((entry) => entry.sites.map((site) => site.id))).not.toContain(
			'site_ro3'
		);
		await endRollouts();
	});

	it('answers 404 for a release that is not registered and 409 when nothing is left to move', async () => {
		install();
		asAdmin();
		expect((await start('rel-none')).status).toBe(404);
		await env.DB.prepare(`UPDATE sites SET release_id = 'rel-c'`).run();
		const reply = await start('rel-c');
		expect(reply.status).toBe(409);
		expect(reply.json).toMatchObject({ details: { reason: 'nothing_to_roll_out' } });
		await env.DB.prepare(`UPDATE sites SET release_id = 'old'`).run();
	});

	it('needs an Idempotency-Key, a recent step-up and a platform admin', async () => {
		install();
		asAdmin();
		expect((await start('rel-c', {}, { 'idempotency-key': '' })).status).toBe(400);
		asAdmin(false);
		const stale = await start('rel-c');
		expect(stale.status).toBe(403);
		expect(stale.json).toMatchObject({ details: { requires: 'step-up' } });
		setup({ deps: { load: async () => ({ resource: {}, facts: facts({ ...fresh }) }) } });
		expect([401, 403, 404]).toContain((await start('rel-c')).status);
		expect(started).toEqual([]);
	});
});

describe('GET and stop', () => {
	it('reads ring progress, the stop reason and the advisory interval', async () => {
		install();
		asAdmin();
		const made = await start('rel-d');
		const id = (made.json as { id: string }).id;
		await env.DB.prepare(
			`UPDATE release_rollouts SET status = 'halted', state = ?, progress = ?,
			 first_ring_at = 2000, last_ring_at = 9000 WHERE id = ?`
		)
			.bind(
				JSON.stringify({
					releaseId: 'rel-d',
					order: ['R4'],
					current: 0,
					received: ['R4'],
					status: 'halted',
					reasons: ['failureRate is 0.05']
				}),
				JSON.stringify({
					R4: { upgraded: ['site_ro0'], failed: ['site_ro1'], reverted: [], stuck: [] }
				}),
				id
			)
			.run();
		const reply = await send(rolloutGet, `${base}/:releaseId/rollout`, {
			path: `${base}/rel-d/rollout`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({
			rollout: {
				status: 'halted',
				currentRing: null,
				reasons: ['failureRate is 0.05'],
				rings: [{ ring: 'R4', reached: true, upgraded: 1, failed: 1 }],
				firstRingAt: 2000,
				lastRingAt: 9000
			}
		});
	});

	it('gives null for a release with no rollout and 404 for an unknown one', async () => {
		install();
		asAdmin();
		const none = await send(rolloutGet, `${base}/:releaseId/rollout`, {
			path: `${base}/rel-a/rollout`.replace('rel-a', 'rel-b'),
			headers: asUser
		});
		expect(none.status).toBe(200);
		const unknown = await send(rolloutGet, `${base}/:releaseId/rollout`, {
			path: `${base}/rel-none/rollout`,
			headers: asUser
		});
		expect(unknown.status).toBe(404);
	});

	it('lists releases with their latest rollout and the interval from the advisory', async () => {
		install();
		asAdmin();
		const reply = await send(listRoute, base, { path: `${base}?kind=worker`, headers: asUser });
		expect(reply.status).toBe(200);
		const releases = (
			reply.json as {
				releases: {
					id: string;
					rollout: { status: string; advisoryIntervalMs: number | null } | null;
				}[];
			}
		).releases;
		const first = releases.find((release) => release.id === 'rel-a')!;
		expect(first.rollout).toMatchObject({ status: 'complete' });
		expect(releases.find((release) => release.id === 'rel-d')!.rollout).toMatchObject({
			status: 'halted'
		});
	});

	it('sets the stop flag on a running rollout and refuses one that ended', async () => {
		install();
		asAdmin();
		const made = await start('rel-c');
		const id = (made.json as { id: string }).id;
		const stop = (rolloutId: string) =>
			send(rolloutStop, `${base}/:releaseId/rollout/stop`, {
				method: 'POST',
				path: `${base}/rel-c/rollout/stop`,
				headers: asUser,
				json: { rolloutId }
			});
		const stopped = await stop(id);
		expect(stopped.status).toBe(200);
		expect(stopped.json).toMatchObject({ stopRequested: true });
		await endRollouts();
		const again = await stop(id);
		expect(again.status).toBe(409);
		expect((await stop('op_missing')).status).toBe(404);
	});
});
