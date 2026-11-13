import type { R2Bucket } from '@cloudflare/workers-types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { D1BoxSiteStore, MAX_KNOWN_ROWS } from '../../../engine/src/box-site-store';
import siteDelete from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/delete.post';
import siteRename from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/rename.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getReadySite, listReadySites, toSite } from '../../../src/server/db/repos/sites';
import { reconcileBoxSites, tokensFor } from '../../../src/server/domain/box-sites';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import { verify } from '../../../src/server/services/audit';
import { removeBoxSite, renameBoxSite } from '../../../src/server/services/box-sites';
import {
	deleteSite,
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { ApiError } from '../../../src/shared/errors';
import { DEPT, ORG, OTHER_ORG, facts, fresh } from '../../unit/domain/fixtures';
import { asUser, send, setup } from '../../unit/server/fixtures/harness';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));
const NOW = 1_800_000_000_000;
const OLD = NOW - 3_600_000;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await getDb();
});
afterAll(() => harness.close());
afterEach(() => {
	resetSiteServices();
	resetApiDeps();
});

const store = () => new D1BoxSiteStore(env.DB, env.BLOB as unknown as R2Bucket);

let counter = 0;
const nodeId = () => `nod_boxsite${String(++counter).padStart(6, '0')}`;
const key = () => `box-site-key-${++counter}-${Date.now()}`;

interface Row {
	id?: string;
	org?: string;
	name?: string;
	plane?: string;
	state?: string;
	host?: string | null;
	node?: string | null;
	foundAs?: string | null;
	missingSince?: number | null;
	readyAt?: number | null;
}

async function insert(row: Row = {}) {
	const id = row.id ?? `site_boxsite${String(++counter).padStart(6, '0')}`;
	await env.DB.prepare(
		`INSERT INTO sites (id, organization_id, name, plane, state, primary_hostname, node_id,
			box_found_as, box_missing_since, ready_at, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			id,
			row.org ?? ORG,
			row.name ?? id,
			row.plane ?? 'self-hosted',
			row.state ?? 'active',
			row.host ?? null,
			row.node ?? null,
			row.foundAs ?? null,
			row.missingSince ?? null,
			row.readyAt === undefined ? OLD : row.readyAt,
			OLD,
			OLD
		)
		.run();
	return id;
}

const rowOf = (id: string) =>
	env.DB.prepare(
		`SELECT name, state, primary_hostname, node_id, box_found_as, box_missing_since, ready_at,
			plane, kind, category, config, account_id, release_id FROM sites WHERE id = ?`
	)
		.bind(id)
		.first<Record<string, unknown>>();

const sitesOf = (org: string) =>
	env.DB.prepare(
		'SELECT id, name, primary_hostname, box_found_as FROM sites WHERE organization_id = ?'
	)
		.bind(org)
		.all<{
			id: string;
			name: string;
			primary_hostname: string | null;
			box_found_as: string | null;
		}>();

describe('the box site store', () => {
	it('reads the self-hosted rows a status frame is compared with, and nothing else', async () => {
		const org = 'org_boxknown001';
		const node = nodeId();
		const live = await insert({ org, host: 'a.example.org', node });
		const dismissed = await insert({
			org,
			host: 'b.example.org',
			node,
			state: 'deleted',
			foundAs: 'b.example.org'
		});
		const unready = await insert({ org, host: 'c.example.org', node, readyAt: null });
		await insert({ org, host: 'gone.example.org', node, state: 'deleted' });
		await insert({ org, host: 'tomb.example.org', node, state: 'tombstoned' });
		await insert({ org, plane: 'managed', host: 'managed.example.org' });
		await insert({ org: 'org_boxknown002', host: 'other.example.org' });
		const rows = await store().known(org);
		expect(rows?.map((row) => row.id).sort()).toEqual([live, dismissed, unready].sort());
		expect(rows?.find((row) => row.id === unready)).toMatchObject({ readyAt: null });
		expect(rows?.find((row) => row.id === live)).toMatchObject({
			name: live,
			host: 'a.example.org',
			foundAs: null,
			nodeId: node,
			state: 'active',
			readyAt: OLD,
			missingSince: null
		});
	});

	it('answers null when the organization holds more rows than a frame can be compared with', async () => {
		const org = 'org_boxmany0001';
		await env.DB.prepare(
			`WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < ${MAX_KNOWN_ROWS + 1})
			 INSERT INTO sites (id, organization_id, name, plane, state, created_at, updated_at)
			 SELECT 'site_boxmany' || n, ?, 'n' || n, 'self-hosted', 'active', 1, 1 FROM c`
		)
			.bind(org)
			.run();
		expect(await store().known(org)).toBeNull();
		await env.DB.prepare('DELETE FROM sites WHERE organization_id = ? AND id = ?')
			.bind(org, 'site_boxmany1')
			.run();
		expect((await store().known(org))?.length).toBe(MAX_KNOWN_ROWS);
	});

	it('creates a found site as a ready self-hosted Drupal row bound to the node, with an audit row', async () => {
		const org = 'org_boxmake0001';
		const node = nodeId();
		const { created } = await store().apply(
			org,
			node,
			{
				create: [
					{
						name: 'www-example-edu',
						host: 'www.example.edu',
						foundAs: 'www.example.edu'
					},
					{ name: 'Site 1 on box', host: null, foundAs: 'h:0123456789abcdef01234567' }
				],
				learn: [],
				markMissing: [],
				markPresent: [],
				unchanged: [],
				ignored: 0,
				skipped: 0
			},
			NOW
		);
		expect(created).toBe(2);
		const { results } = await sitesOf(org);
		expect(results).toHaveLength(2);
		const clear = results.find((row) => row.box_found_as === 'www.example.edu')!;
		expect(await rowOf(clear.id)).toMatchObject({
			name: 'www-example-edu',
			state: 'active',
			plane: 'self-hosted',
			kind: 'drupal',
			category: 'cms',
			config: 'canonical',
			primary_hostname: 'www.example.edu',
			node_id: node,
			box_found_as: 'www.example.edu',
			box_missing_since: null,
			ready_at: NOW,
			account_id: null,
			release_id: null
		});
		const hashed = results.find((row) => row.box_found_as?.startsWith('h:'))!;
		expect(hashed.primary_hostname).toBeNull();
		const audit = await env.DB.prepare(
			'SELECT actor, action, target, detail FROM audit_log WHERE organization_id = ? ORDER BY seq'
		)
			.bind(org)
			.all<{ actor: string; action: string; target: string; detail: string }>();
		expect(audit.results).toHaveLength(2);
		expect(audit.results.map((row) => row.target).sort()).toEqual([clear.id, hashed.id].sort());
		for (const row of audit.results) {
			expect(row).toMatchObject({ actor: `node:${node}`, action: 'site.found' });
			expect(JSON.parse(row.detail)).toEqual({ nodeId: node });
		}
		expect(await verify(await getDb(), org)).toBeNull();
	});

	it('does not make a second row for a name the node already has, found or removed', async () => {
		const org = 'org_boxdupe0001';
		const node = nodeId();
		const changes = {
			create: [{ name: 'x-example-org', host: 'x.example.org', foundAs: 'x.example.org' }],
			learn: [],
			markMissing: [],
			markPresent: [],
			unchanged: [],
			ignored: 0,
			skipped: 0
		};
		expect((await store().apply(org, node, changes, NOW)).created).toBe(1);
		expect((await store().apply(org, node, changes, NOW)).created).toBe(0);
		await env.DB.prepare("UPDATE sites SET state = 'deleted' WHERE organization_id = ?")
			.bind(org)
			.run();
		expect((await store().apply(org, node, changes, NOW)).created).toBe(0);
		expect((await sitesOf(org)).results).toHaveLength(1);
	});

	it('marks, clears and learns only on rows bound to the node, with the organization named first', async () => {
		const org = 'org_boxmark0001';
		const node = nodeId();
		const other = nodeId();
		const mine = await insert({ org, host: 'a.example.org', node });
		const gone = await insert({ org, host: 'b.example.org', node, missingSince: OLD });
		const hashed = await insert({ org, node, foundAs: 'h:0123456789abcdef01234567' });
		const theirs = await insert({ org, host: 'c.example.org', node: other });
		const elsewhere = await insert({ org: 'org_boxmark0002', host: 'd.example.org', node });
		await store().apply(
			org,
			node,
			{
				create: [],
				learn: [{ id: hashed, host: 'h.example.org' }],
				markMissing: [mine, theirs, elsewhere],
				markPresent: [gone],
				unchanged: [],
				ignored: 0,
				skipped: 0
			},
			NOW
		);
		expect(await rowOf(mine)).toMatchObject({ box_missing_since: NOW });
		expect(await rowOf(gone)).toMatchObject({ box_missing_since: null });
		expect(await rowOf(hashed)).toMatchObject({
			primary_hostname: 'h.example.org',
			box_found_as: 'h.example.org'
		});
		expect(await rowOf(theirs)).toMatchObject({ box_missing_since: null });
		expect(await rowOf(elsewhere)).toMatchObject({ box_missing_since: null });
	});

	it('does not move a mark that is already set, so a repeat writes nothing new', async () => {
		const org = 'org_boxrepeat01';
		const node = nodeId();
		const id = await insert({ org, host: 'a.example.org', node, missingSince: OLD });
		await store().apply(
			org,
			node,
			{
				create: [],
				learn: [],
				markMissing: [id],
				markPresent: [],
				unchanged: [],
				ignored: 0,
				skipped: 0
			},
			NOW
		);
		expect(await rowOf(id)).toMatchObject({ box_missing_since: OLD });
	});

	it('settles on a quiet answer after one frame, through the same path the link takes', async () => {
		const org = 'org_boxflow0001';
		const node = nodeId();
		const known = await insert({ org, name: 'campus', host: 'a.example.org', node });
		const frame = { names: ['a.example.org', 'new.example.org'], hashed: false };
		for (let pass = 0; pass < 3; pass++) {
			const rows = (await store().known(org))!;
			const changes = reconcileBoxSites({
				nodeId: node,
				nodeLabel: 'campus box',
				known: rows,
				frame,
				tokenOf: await tokensFor(node, rows, frame),
				now: NOW
			});
			expect(changes.create.length, `pass ${pass}`).toBe(pass === 0 ? 1 : 0);
			await store().apply(org, node, changes, NOW);
		}
		const { results } = await sitesOf(org);
		expect(results.map((row) => row.primary_hostname).sort()).toEqual([
			'a.example.org',
			'new.example.org'
		]);
		expect(await rowOf(known)).toMatchObject({ box_missing_since: null });
		const gone = (await store().known(org))!;
		const empty = reconcileBoxSites({
			nodeId: node,
			nodeLabel: 'campus box',
			known: gone,
			frame: { names: [], hashed: false },
			tokenOf: () => '',
			now: NOW
		});
		expect(empty.markMissing).toEqual([known]);
	});
});

describe('a site found on a box in the lists', () => {
	it('is listed with its box state, and carries the missing time once the box lets it go', async () => {
		const org = 'org_boxlist0001';
		const node = nodeId();
		const found = await insert({ org, host: 'f.example.org', node, foundAs: 'f.example.org' });
		const made = await insert({ org, host: 'm.example.org', node, missingSince: NOW });
		const listed = await listReadySites(await getDb(), org, { count: 10 });
		const byId = new Map(listed.map((row) => [row.id, toSite(row)]));
		expect(byId.get(found)?.box).toEqual({ found: true, missingSince: null });
		expect(byId.get(made)?.box).toEqual({
			found: false,
			missingSince: new Date(NOW).toISOString()
		});
	});
});

describe('removing a site on a box', () => {
	function install() {
		const started: unknown[] = [];
		const entitlement = derive(FREE_PLAN_ID);
		if (!entitlement.ok) throw new Error(entitlement.reason);
		setSiteServices({
			getDb,
			entitlements: {
				check: async () => ({ allow: true, entitlement: entitlement.entitlement })
			},
			startOperation: async (request) => {
				started.push(request);
			},
			config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases: {} }
		});
		return started;
	}
	const remove = (siteId: string, confirm: string, idempotencyKey = key(), orgId = ORG) =>
		deleteSite(siteServices(), { orgId, siteId, confirm, idempotencyKey });
	const reason = async (promise: Promise<unknown>) => {
		try {
			await promise;
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			return (error as ApiError).details as { reason?: string };
		}
		throw new Error('expected a refusal');
	};

	it('takes the row of a found site and starts nothing on the box', async () => {
		const started = install();
		const id = await insert({
			name: 'found-one',
			host: 'one.example.org',
			foundAs: 'one.example.org'
		});
		const stored = await remove(id, 'found-one');
		expect(stored.operation).toMatchObject({
			type: 'site.delete',
			status: 'succeeded',
			verification: 'not-required',
			targetIds: [id]
		});
		expect(stored.operation.steps.map((step) => [step.id, step.state])).toEqual([
			['remove', 'succeeded']
		]);
		expect(started).toEqual([]);
		expect(await rowOf(id)).toMatchObject({
			state: 'deleted',
			box_found_as: 'one.example.org'
		});
	});

	it('answers a repeated key with the same operation and a second delete with the plain refusal', async () => {
		install();
		const id = await insert({
			name: 'found-two',
			host: 'two.example.org',
			foundAs: 'two.example.org'
		});
		const repeated = key();
		const first = await remove(id, 'found-two', repeated);
		expect((await remove(id, 'found-two', repeated)).operation.id).toBe(first.operation.id);
		expect(await reason(remove(id, 'found-two'))).toEqual({ reason: 'site_not_live' });
	});

	it('wants the name typed and refuses a wrong one before anything changes', async () => {
		install();
		const id = await insert({ name: 'found-three', foundAs: 'h:0123456789abcdef01234567' });
		expect(await reason(remove(id, 'found-thre'))).toEqual({ reason: 'confirm_mismatch' });
		expect(await rowOf(id)).toMatchObject({ state: 'active' });
		const ops = await env.DB.prepare('SELECT id FROM operations WHERE site_id = ?')
			.bind(id)
			.all();
		expect(ops.results).toEqual([]);
	});

	it('takes the row of a site the dashboard made once the box no longer has it', async () => {
		install();
		const id = await insert({ name: 'made-gone', host: 'gone.example.org', missingSince: OLD });
		expect((await remove(id, 'made-gone')).operation.status).toBe('succeeded');
		expect(await rowOf(id)).toMatchObject({ state: 'deleted', box_found_as: null });
	});

	it('refuses a site the dashboard made while the box still reports it', async () => {
		install();
		const id = await insert({ name: 'made-here', host: 'here.example.org' });
		expect(await reason(remove(id, 'made-here'))).toEqual({ reason: 'box_site' });
		expect(await rowOf(id)).toMatchObject({ state: 'active' });
	});

	it('refuses while another change to the site is running', async () => {
		install();
		const id = await insert({
			name: 'found-busy',
			foundAs: 'busy.example.org',
			host: 'busy.example.org'
		});
		await env.DB.prepare(
			`INSERT INTO operations (id, organization_id, site_id, type, status, idempotency_key,
				target_ids, preconditions, plan_digest, fencing_epoch, blast_radius, verification,
				budget, created_at, updated_at, version)
			 VALUES ('op_boxbusy0001', ?, ?, 'repair.run', 'running', 'busy-key', '[]', '[]', 'x', 0,
				'{}', 'not-required', '{}', 1, 1, 0)`
		)
			.bind(ORG, id)
			.run();
		expect(await reason(remove(id, 'found-busy'))).toMatchObject({ reason: 'site_busy' });
		expect(await rowOf(id)).toMatchObject({ state: 'active' });
	});

	it('keeps a removed found site from coming back when the box still reports it', async () => {
		install();
		const org = 'org_boxdismiss01';
		const node = nodeId();
		const id = await insert({
			org,
			name: 'found-dismiss',
			host: 'back.example.org',
			node,
			foundAs: 'back.example.org'
		});
		await remove(id, 'found-dismiss', key(), org);
		const rows = (await store().known(org))!;
		const frame = { names: ['back.example.org'], hashed: false };
		const changes = reconcileBoxSites({
			nodeId: node,
			nodeLabel: 'box',
			known: rows,
			frame,
			tokenOf: await tokensFor(node, rows, frame),
			now: NOW
		});
		expect(changes.create).toEqual([]);
	});

	it('ends the operation as failed when the row changed between the read and the write', async () => {
		install();
		const id = await insert({ name: 'found-race', foundAs: 'race.example.org' });
		const stale = (await getReadySite(await getDb(), ORG, id))!;
		await env.DB.prepare("UPDATE sites SET state = 'deleted' WHERE id = ?").bind(id).run();
		const idempotencyKey = key();
		await expect(
			removeBoxSite(await getDb(), stale, {
				orgId: ORG,
				confirm: 'found-race',
				idempotencyKey
			})
		).rejects.toMatchObject({ details: { reason: 'site_not_live' } });
		const op = await env.DB.prepare(
			'SELECT status FROM operations WHERE site_id = ? AND idempotency_key = ?'
		)
			.bind(id, idempotencyKey)
			.first<{ status: string }>();
		expect(op?.status).toBe('failed');
	});

	it('does not reach a site of another organization', async () => {
		install();
		const id = await insert({ org: OTHER_ORG, name: 'other-found', foundAs: 'o.example.org' });
		await expect(remove(id, 'other-found')).rejects.toMatchObject({ code: 'not_found' });
		expect(await rowOf(id)).toMatchObject({ state: 'active' });
	});
});

describe('renaming a site found on a box', () => {
	const call = async (siteId: string, name: string, orgId = ORG) =>
		renameBoxSite(await getDb(), { orgId, siteId, name });
	const refusal = async (promise: Promise<unknown>) => {
		try {
			await promise;
		} catch (error) {
			expect(error).toBeInstanceOf(ApiError);
			return error as ApiError;
		}
		throw new Error('expected a refusal');
	};

	it('changes the name of a found site and returns the site as it now stands', async () => {
		const id = await insert({ name: 'Site 1 on box', foundAs: 'h:0123456789abcdef01234567' });
		const site = await call(id, '  Library Portal  ');
		expect(site).toMatchObject({ id, name: 'Library Portal', box: { found: true } });
		expect(await rowOf(id)).toMatchObject({ name: 'Library Portal' });
		expect((await getReadySite(await getDb(), ORG, id))?.name).toBe('Library Portal');
	});

	it('refuses an empty name, a long one and one with a control character', async () => {
		const id = await insert({ name: 'keep-me', foundAs: 'h:0123456789abcdef01234567' });
		for (const name of ['', '   ', 'x'.repeat(101), 'two\nlines']) {
			const failure = await refusal(call(id, name));
			expect(failure.code, name).toBe('validation');
		}
		expect(await rowOf(id)).toMatchObject({ name: 'keep-me' });
	});

	it('refuses a name another live site of the organization holds, and lets its own name stand', async () => {
		await insert({ name: 'taken-name', host: 't.example.org' });
		const id = await insert({ name: 'rename-me', foundAs: 'h:0123456789abcdef01234567' });
		const failure = await refusal(call(id, 'taken-name'));
		expect(failure.details).toEqual({ reason: 'name_taken' });
		expect((await call(id, 'rename-me')).name).toBe('rename-me');
	});

	it('refuses a site the dashboard made, a removed site, a missing one and another organization', async () => {
		const made = await insert({ name: 'made-here-too', host: 'm2.example.org' });
		expect((await refusal(call(made, 'new-name'))).details).toEqual({
			reason: 'not_renamable'
		});
		const gone = await insert({
			name: 'gone-found',
			foundAs: 'g.example.org',
			state: 'deleted'
		});
		expect((await refusal(call(gone, 'new-name'))).details).toEqual({
			reason: 'not_renamable'
		});
		expect((await refusal(call('site_nope00000001', 'new-name'))).code).toBe('not_found');
		const foreign = await insert({ org: OTHER_ORG, name: 'foreign', foundAs: 'f.example.org' });
		expect((await refusal(call(foreign, 'new-name'))).code).toBe('not_found');
		expect(await rowOf(foreign)).toMatchObject({ name: 'foreign' });
	});
});

describe('the rename route and the delete route for a site on a box', () => {
	const ROUTE = '/api/v1/orgs/:orgId/sites/:id/rename';
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
	const post = (siteId: string, json: unknown) =>
		send(siteRename, ROUTE, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites/${siteId}/rename`,
			headers: asUser,
			json
		});

	function installServices() {
		setSiteServices({
			getDb,
			entitlements: { check: async () => ({ allow: false, reason: 'plan_limit' as never }) },
			startOperation: async () => undefined,
			config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases: {} }
		});
	}

	it('answers 200 with the site for an owner and 403 for a viewer', async () => {
		installServices();
		const id = await insert({
			name: 'route-found',
			foundAs: 'r.example.org',
			host: 'r.example.org'
		});
		asRole('viewer');
		expect((await post(id, { name: 'blocked' })).status).toBe(403);
		expect(await rowOf(id)).toMatchObject({ name: 'route-found' });
		asRole('owner');
		const reply = await post(id, { name: 'route-renamed' });
		expect(reply.status).toBe(200);
		expect(reply.json).toMatchObject({ id, name: 'route-renamed', box: { found: true } });
	});

	it('answers 422 for a site that was not found on a box and 400 for an unknown field', async () => {
		installServices();
		const id = await insert({ name: 'route-made', host: 'rm.example.org' });
		asRole('owner');
		const refused = await post(id, { name: 'x-new' });
		expect(refused.status).toBe(422);
		expect(refused.json).toMatchObject({ details: { reason: 'not_renamable' } });
		expect((await post(id, { name: 'x-new', extra: true })).status).toBe(400);
	});

	it('answers the delete route with a finished operation for a found site', async () => {
		installServices();
		const id = await insert({
			name: 'route-delete',
			foundAs: 'rd.example.org',
			host: 'rd.example.org'
		});
		asRole('owner');
		const reply = await send(siteDelete, '/api/v1/orgs/:orgId/sites/:id/delete', {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/sites/${id}/delete`,
			headers: { ...asUser, 'idempotency-key': key() },
			json: { confirm: 'route-delete' }
		});
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({ type: 'site.delete', status: 'succeeded' });
		expect(await rowOf(id)).toMatchObject({ state: 'deleted' });
	});
});
