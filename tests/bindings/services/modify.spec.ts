import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildEditBundle, editBundleBytes, editKeys } from '../../../engine/src/modify-bundle';
import revisionList from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/revisions.get';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { registerRelease } from '../../../src/server/db/repos/releases';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import {
	modifyServices,
	modifySiteFiles,
	resetModifyServices,
	rollbackSiteEdit,
	setModifyServices
} from '../../../src/server/services/modify';
import { resetSiteServices, setSiteServices } from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { DEPT, ORG, facts, fresh } from '../../unit/domain/fixtures';
import { asUser, send, setup } from '../../unit/server/fixtures/harness';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));
const digest = `sha256:${'1'.repeat(64)}`;
const NOW = 1_790_000_000_000;
const PACKAGE = 'my_module';
const ROOT = `modules/custom/${PACKAGE}`;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	const db = await getDb();
	const base = { manifestDigest: digest, publishedAt: NOW, now: NOW };
	await registerRelease(db, {
		...base,
		id: 'rel-old',
		kind: 'worker',
		version: '1.0.0',
		schemaVersion: 1,
		acceptsSchema: 1
	});
	await registerRelease(db, {
		...base,
		id: 'rel-new',
		kind: 'worker',
		version: '1.1.0',
		schemaVersion: 2,
		acceptsSchema: 1
	});
});

afterAll(() => harness.close());
afterEach(() => {
	resetSiteServices();
	resetModifyServices();
	resetApiDeps();
});

const stored = new Map<string, Uint8Array>();
const audits: { action: string; target: string }[] = [];

function wire(options: { customCode?: boolean; token?: boolean } = {}) {
	const started: EngineStartRequest[] = [];
	const derived = derive(FREE_PLAN_ID);
	if (!derived.ok) throw new Error(derived.reason);
	const entitlement = {
		...derived.entitlement,
		features: { ...derived.entitlement.features, customCode: options.customCode ?? true }
	};
	stored.clear();
	audits.length = 0;
	setModifyServices({
		getDb,
		startOperation: async (request) => {
			started.push(request);
		},
		planOf: async () => entitlement,
		audit: async (_org, input) => {
			audits.push({ action: input.action, target: input.target ?? '' });
		},
		ownerTokens: {
			get: async () => (options.token === false ? null : ({ token: 'sealed' } as never))
		},
		blobs: {
			put: async (key, bytes) => void stored.set(key, bytes),
			get: async (key) => stored.get(key) ?? null
		}
	});
	return started;
}

let counter = 0;
async function liveSite(plane: 'managed' | 'self-managed' = 'managed', dataSchema = 1) {
	const id = `site_modify${String(++counter).padStart(4, '0')}`;
	await env.DB.prepare(
		`INSERT INTO sites (id, organization_id, name, kind, plane, state, account_id, primary_hostname,
			release_id, ready_at, data_schema_version, created_at, updated_at)
		 VALUES (?, ?, ?, 'drupal', ?, 'active', ?, ?, 'rel-new', 1, ?, 1, 1)`
	)
		.bind(id, ORG, `Edit ${counter}`, plane, 'a'.repeat(32), `${id}.example.edu`, dataSchema)
		.run();
	return id;
}

const files = (version = 1) => [
	{ path: `${ROOT}/${PACKAGE}.info.yml`, content: 'name: Mine\ntype: module\n' },
	{ path: `${ROOT}/${PACKAGE}.module`, content: `<?php\n// v${version}\n` }
];

const request = (siteId: string, key: string) => ({
	orgId: ORG,
	siteId,
	actor: 'user:1',
	idempotencyKey: key,
	operationId: `op_${key.padEnd(12, 'x')}`
});

const insertRevision = (
	siteId: string,
	row: { id: string; kind: 'release' | 'edit'; release?: string; bundle?: string; note?: string },
	at: number
) =>
	env.DB.prepare(
		`INSERT INTO site_revisions (id, organization_id, site_id, kind, release_id, bundle_key, note,
			created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
	)
		.bind(
			row.id,
			ORG,
			siteId,
			row.kind,
			row.release ?? null,
			row.bundle ?? null,
			row.note ?? null,
			at
		)
		.run();

describe.each(['managed', 'self-managed'] as const)('modifySiteFiles on a %s site', (plane) => {
	it('stores the bundle, starts modify-apply and records the operation once', async () => {
		const started = wire();
		const siteId = await liveSite(plane);
		const input = {
			...request(siteId, `k1${plane}`.slice(0, 10)),
			files: files(),
			note: 'Fix'
		};
		const first = await modifySiteFiles(modifyServices(), input);
		expect(first.operation.type).toBe('modify.apply');
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({ workflow: 'modify-apply', id: input.operationId });
		const params = started[0]!.params as { bundleKey: string; name: string; note: string };
		expect(params).toMatchObject({ name: PACKAGE, note: 'Fix' });
		expect(params.bundleKey).toBe(editKeys.bundle(ORG, siteId, input.operationId));
		expect(stored.has(params.bundleKey)).toBe(true);
		expect(audits).toEqual([{ action: 'site.modify', target: siteId }]);
		const again = await modifySiteFiles(modifyServices(), {
			...input,
			operationId: 'op_other00000'
		});
		expect(again.operation.id).toBe(first.operation.id);
		expect(started).toHaveLength(1);
	});
});

describe('modifySiteFiles refusals', () => {
	const refusal = async (siteId: string, key: string, set = files()) => {
		const input = { ...request(siteId, key), files: set, note: 'Fix' };
		return modifySiteFiles(modifyServices(), input).catch((error: Error) => error);
	};

	it('refuses a plan without custom code, a site without an owner token, and a missing site', async () => {
		const started = wire({ customCode: false });
		const siteId = await liveSite();
		expect(await refusal(siteId, 'plan0001')).toMatchObject({
			details: { reason: 'feature_not_included' }
		});
		wire({ token: false });
		expect(await refusal(await liveSite(), 'token001')).toMatchObject({
			details: { reason: 'no_owner_token' }
		});
		wire();
		expect(await refusal('site_modifygone0', 'gone0001')).toMatchObject({ code: 'not_found' });
		expect(started).toEqual([]);
	});

	it('refuses a path outside custom code with the reason for that file and stores nothing', async () => {
		const started = wire();
		const siteId = await liveSite();
		const error = await refusal(siteId, 'path0001', [
			{ path: 'core/lib/Drupal.php', content: '<?php' }
		]);
		expect(error).toMatchObject({
			code: 'unprocessable',
			details: { reason: 'files_refused', problems: [{ file: 0 }] }
		});
		expect(started).toEqual([]);
		expect(stored.size).toBe(0);
	});

	it('refuses a second edit while the first still runs', async () => {
		wire();
		const siteId = await liveSite();
		await modifySiteFiles(modifyServices(), {
			...request(siteId, 'busy0001'),
			files: files(),
			note: 'First'
		});
		expect(await refusal(siteId, 'busy0002')).toMatchObject({
			code: 'conflict',
			details: { reason: 'site_busy' }
		});
	});
});

describe('the edit row and rollback to it', () => {
	const REVISIONS = '/api/v1/orgs/:orgId/sites/:id/revisions';
	const asViewer = () =>
		setup({
			deps: {
				load: async (input) => ({
					resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
					facts: facts({ membership: { orgId: ORG, role: 'viewer' }, ...fresh })
				})
			}
		});
	const listed = async (siteId: string) => {
		setSiteServices({ getDb });
		asViewer();
		const reply = await send(revisionList, REVISIONS, {
			path: `/api/v1/orgs/${ORG}/sites/${siteId}/revisions`,
			headers: asUser
		});
		expect(reply.status).toBe(200);
		return (
			reply.json as {
				items: {
					id: string;
					kind: string;
					release: string | null;
					bundle: boolean;
					note: string | null;
					current: boolean;
				}[];
			}
		).items;
	};

	it('lists an edit row with its note and bundle between release rows, newest first', async () => {
		const siteId = await liveSite();
		await insertRevision(
			siteId,
			{ id: `rev_${siteId}_1`, kind: 'release', release: 'rel-new' },
			1
		);
		await insertRevision(
			siteId,
			{
				id: `rev_${siteId}_2`,
				kind: 'edit',
				release: 'rel-new',
				bundle: 'edits/k',
				note: 'Fix'
			},
			2
		);
		const items = await listed(siteId);
		expect(items.map((item) => [item.kind, item.bundle, item.note])).toEqual([
			['edit', true, 'Fix'],
			['release', false, null]
		]);
		expect(items[0]!.current).toBe(true);
	});

	it('rolls back to an edit by delivering its stored files again with a note naming it', async () => {
		const started = wire();
		const siteId = await liveSite();
		const key = editKeys.bundle(ORG, siteId, 'op_earlier0000');
		stored.set(
			key,
			editBundleBytes(
				await buildEditBundle(PACKAGE, [
					{ path: `${ROOT}/${PACKAGE}.module`, source: '<?php', bytes: 5 }
				])
			)
		);
		await insertRevision(
			siteId,
			{
				id: 'rev_op_earlier0000',
				kind: 'edit',
				release: 'rel-new',
				bundle: key,
				note: 'Fix'
			},
			5
		);
		const operation = await rollbackSiteEdit(modifyServices(), {
			...request(siteId, 'roll0001'),
			revisionId: 'rev_op_earlier0000'
		});
		expect(operation.operation.type).toBe('modify.apply');
		expect(started[0]!.params).toMatchObject({
			name: PACKAGE,
			bundleKey: key,
			note: 'Rolled back to: Fix'
		});
		expect(audits).toEqual([{ action: 'site.modify.rollback', target: siteId }]);
	});

	it('refuses a row with no stored files, a missing bundle, a damaged bundle and an unknown row', async () => {
		wire();
		const siteId = await liveSite();
		await insertRevision(
			siteId,
			{ id: `rev_${siteId}_r`, kind: 'release', release: 'rel-new' },
			1
		);
		await insertRevision(
			siteId,
			{ id: `rev_${siteId}_m`, kind: 'edit', bundle: 'edits/missing' },
			2
		);
		await insertRevision(
			siteId,
			{ id: `rev_${siteId}_d`, kind: 'edit', bundle: 'edits/bad' },
			3
		);
		stored.set('edits/bad', new TextEncoder().encode('nope'));
		const attempt = (id: string, key: string) =>
			rollbackSiteEdit(modifyServices(), { ...request(siteId, key), revisionId: id }).catch(
				(error: Error) => error
			);
		expect(await attempt(`rev_${siteId}_r`, 'rr000001')).toMatchObject({
			details: { reason: 'no_bundle' }
		});
		expect(await attempt(`rev_${siteId}_m`, 'rm000001')).toMatchObject({
			details: { reason: 'bundle_missing' }
		});
		expect(await attempt(`rev_${siteId}_d`, 'rd000001')).toMatchObject({
			details: { reason: 'bundle_invalid' }
		});
		expect(await attempt('rev_nothing', 'rn000001')).toMatchObject({ code: 'not_found' });
	});

	it('applies the data guard only when the edit names a release', async () => {
		const started = wire();
		const siteId = await liveSite('managed', 2);
		const key = editKeys.bundle(ORG, siteId, 'op_guard000000');
		stored.set(
			key,
			editBundleBytes(
				await buildEditBundle(PACKAGE, [
					{ path: `${ROOT}/${PACKAGE}.module`, source: '<?php', bytes: 5 }
				])
			)
		);
		await insertRevision(
			siteId,
			{ id: 'rev_guarded', kind: 'edit', release: 'rel-old', bundle: key, note: 'Old' },
			1
		);
		await insertRevision(
			siteId,
			{ id: 'rev_free', kind: 'edit', bundle: key, note: 'Free' },
			2
		);
		const guarded = await rollbackSiteEdit(modifyServices(), {
			...request(siteId, 'guard001'),
			revisionId: 'rev_guarded'
		}).catch((error: Error) => error);
		expect(guarded).toMatchObject({ details: { reason: 'rollback_refused' } });
		expect(started).toEqual([]);
		await rollbackSiteEdit(modifyServices(), {
			...request(siteId, 'guard002'),
			revisionId: 'rev_free'
		});
		expect(started).toHaveLength(1);
	});
});
