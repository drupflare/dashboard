import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CUSTOM_ARCHIVE_MAX_BYTES, customKeys } from '../../../engine/src/custom-bundle';
import intake from '../../../src/server/api/v1/orgs/[orgId]/custom-bundles.post';
import bundle from '../../../src/server/api/v1/orgs/[orgId]/sites/[id]/bundle.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getCustomRelease } from '../../../src/server/db/repos/custom-releases';
import { markSiteReady } from '../../../src/server/db/repos/sites';
import { check, derive, type Entitlement } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import {
	bundleFileName,
	customBundleServices as bundleServices,
	intakeCustomBundle,
	resetCustomBundleServices,
	setCustomBundleServices
} from '../../../src/server/services/custom-bundles';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import { checkRollback, listRevisions } from '../../../src/server/services/rollback-check';
import {
	createSite,
	resetSiteServices,
	setSiteServices,
	siteServices,
	upgradeSite
} from '../../../src/server/services/sites';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { ApiError } from '../../../src/shared/errors';
import { DEPT, ORG, OTHER_ORG, facts, fresh } from '../../unit/domain/fixtures';
import { goodFiles, streamOf, tarGz, type Files } from '../../unit/engine/custom-fixtures';
import { asUser, send as sendRequest, setup } from '../../unit/server/fixtures/harness';
import { installPendingSecrets, openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));

const MARKER = 'LEAK-MARKER-b81c40';
const NOW = Date.parse('2026-11-14T12:00:00Z');
const OTHER = OTHER_ORG;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
});

afterAll(() => harness.close());

afterEach(() => {
	resetSiteServices();
	resetCustomBundleServices();
	resetPendingSecretDeps();
});

const entitlement = (planId: string): Entitlement => {
	const result = derive(planId);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

function install(planId = 'managed-pro') {
	const objects = new Map<string, Uint8Array>();
	const started: EngineStartRequest[] = [];
	const plan = entitlement(planId);
	setCustomBundleServices({
		getDb,
		planOf: async () => plan,
		blobs: { put: async (key, bytes) => void objects.set(key, bytes) },
		now: () => NOW
	});
	installPendingSecrets(getDb);
	setSiteServices({
		getDb,
		entitlements: {
			check: async ({ kind }) => {
				const decision = check('site.create', plan, {
					sitesInOrg: 0,
					customWorker: kind === 'custom'
				});
				return decision.allow ? { allow: true, entitlement: plan } : decision;
			}
		},
		planOf: async () => plan,
		startOperation: async (request) => {
			started.push(request);
		},
		config: { hostSuffix: 'drupflare.app', accountId: 'a'.repeat(32), releases: {} }
	});
	return { objects, started };
}

const withMarker = (extra: Record<string, unknown> = {}, file = 'v1'): Files =>
	goodFiles(extra, {
		'dist/index.js': `export default { fetch() { return new Response("${MARKER} ${file}"); } };`
	});

const DO_CONFIG = {
	durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
	migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
};

async function upload(files: Files, orgId = ORG, fileName = 'app.tar.gz') {
	return intakeCustomBundle(bundleServices(), {
		orgId,
		body: streamOf(await tarGz(files)),
		fileName
	});
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ApiError) return error;
		throw error;
	}
	throw new Error('expected a refusal');
}

let counter = 0;
const key = () => `cb-key-${++counter}-${Date.now()}`;

const create = (bundleId: string | undefined, orgId = ORG, kind: 'custom' | 'drupal' = 'custom') =>
	createSite(siteServices(), {
		orgId,
		userId: 'user-bindings',
		kind,
		name: `quiet-bundle-${++counter}`,
		hostnameLabel: undefined,
		idempotencyKey: key(),
		bundleId
	});

async function liveCustomSite(bundleId: string, orgId = ORG) {
	const stored = await create(bundleId, orgId);
	const siteId = stored.operation.targetIds[0] as string;
	await env.DB.prepare('UPDATE operations SET status = ? WHERE id = ?')
		.bind('succeeded', stored.operation.id)
		.run();
	await env.DB.prepare('UPDATE sites SET account_id = ?, release_id = ? WHERE id = ?')
		.bind('a'.repeat(32), bundleId, siteId)
		.run();
	await markSiteReady(await getDb(), orgId, siteId, 5_000);
	return siteId;
}

describe('the upload', () => {
	it('stores a deployable bundle once and answers with its id and findings', async () => {
		const { objects } = install();
		const files = withMarker();
		const first = await intakeCustomBundle(
			{ ...bundleServices(), blobs: { put: async (k, b) => void objects.set(k, b) } },
			{ orgId: ORG, body: streamOf(await tarGz(files)), fileName: '../../tmp/app.tar.gz' }
		);
		expect(first).toMatchObject({ deployable: true, fileName: 'app.tar.gz' });
		expect(first.bundleId).toMatch(/^cust-[0-9a-f]{32}$/);
		expect(first.recipe.id).toBe('bring-your-own');
		expect(objects.has(customKeys.archive(ORG, first.sha256))).toBe(true);
		expect(objects.has(`releases/${first.bundleId}/manifest.json`)).toBe(true);
		const again = await intakeCustomBundle(
			{ ...bundleServices(), blobs: { put: async (k, b) => void objects.set(k, b) } },
			{ orgId: ORG, body: streamOf(await tarGz(files)), fileName: 'renamed.tar.gz' }
		);
		expect(again.bundleId).toBe(first.bundleId);
		expect(again.fileName).toBe('app.tar.gz');
		const row = await getCustomRelease(await getDb(), ORG, first.bundleId!);
		expect(row).toMatchObject({ fileName: 'app.tar.gz', sha256: first.sha256 });
	});

	it('gives the same archive another id in another organization', async () => {
		install();
		const a = await upload(withMarker(), ORG);
		const b = await upload(withMarker(), OTHER);
		expect(a.bundleId).not.toBe(b.bundleId);
		expect(await getCustomRelease(await getDb(), OTHER, a.bundleId!)).toBeNull();
	});

	it('stores nothing for a bundle with a blocking finding', async () => {
		const { objects } = install();
		const result = await intakeCustomBundle(bundleServices(), {
			orgId: ORG,
			body: streamOf(await tarGz(withMarker({ ai: { binding: 'AI' } }))),
			fileName: 'app.tar.gz'
		});
		expect(result.deployable).toBe(false);
		expect(result.bundleId).toBeNull();
		expect(result.findings.map((finding) => finding.code)).toContain('binding-unverified');
		expect(objects.size).toBe(0);
	});

	it('refuses a plan without custom code and names the plan that has it', async () => {
		const { objects } = install('managed-free');
		const error = await refusal(
			intakeCustomBundle(bundleServices(), {
				orgId: ORG,
				body: streamOf(await tarGz(withMarker())),
				fileName: 'app.tar.gz'
			})
		);
		expect(error.code).toBe('forbidden');
		expect(error.details).toEqual({
			requires: 'entitlement',
			feature: 'customCode',
			unlockedBy: { id: 'managed-pro', name: 'Managed Pro' }
		});
		expect(objects.size).toBe(0);
	});

	it('refuses an unsafe archive with its reason and a body over the cap', async () => {
		install();
		const unsafe = await refusal(
			intakeCustomBundle(bundleServices(), {
				orgId: ORG,
				body: streamOf(await tarGz({ ...withMarker(), '../evil.js': 'x' })),
				fileName: 'a.tgz'
			})
		);
		expect(unsafe.code).toBe('unprocessable');
		expect(unsafe.details).toEqual({ reason: 'archive_unsafe_path' });
		const big = await refusal(
			intakeCustomBundle(bundleServices(), {
				orgId: ORG,
				body: streamOf(new Uint8Array(CUSTOM_ARCHIVE_MAX_BYTES + 1)),
				fileName: 'a.tgz'
			})
		);
		expect(big.code).toBe('validation');
		expect(big.details).toEqual({ reason: 'archive_too_large' });
		const none = await refusal(
			intakeCustomBundle(bundleServices(), { orgId: ORG, body: null, fileName: 'a.tgz' })
		);
		expect(none.code).toBe('validation');
	});

	it('cleans a file name down to its last printable part', () => {
		expect(bundleFileName('C:\\build\\app.tar.gz')).toBe('app.tar.gz');
		expect(bundleFileName('a/b/\u0001c.tgz')).toBe('c.tgz');
		expect(bundleFileName(undefined)).toBe('bundle.tar.gz');
		expect(bundleFileName('x'.repeat(300))).toHaveLength(100);
	});
});

describe('creating a site from a bundle', () => {
	it('starts the create from the bundle and carries no bundle bytes', async () => {
		const { started } = install();
		const bundle = await upload(withMarker());
		const stored = await create(bundle.bundleId!);
		expect(started).toHaveLength(1);
		const params = started[0]!.params as {
			releaseId: string;
			site: { kind: string; category: string };
			customResources: unknown;
		};
		expect(started[0]!.workflow).toBe('site-create');
		expect(params.releaseId).toBe(bundle.bundleId);
		expect(params.site).toMatchObject({ kind: 'custom', category: 'workers' });
		expect(params.customResources).toEqual([
			{ kind: 'kv', binding: 'CACHE' },
			{ kind: 'r2', binding: 'UPLOADS' }
		]);
		const record = await env.DB.prepare('SELECT * FROM operations WHERE id = ?')
			.bind(stored.operation.id)
			.first();
		expect(JSON.stringify(record)).toContain(bundle.bundleId);
		expect(JSON.stringify(record)).not.toContain(MARKER);
		expect(JSON.stringify(started)).not.toContain(MARKER);
	});

	it('refuses a free plan and names the plan that unlocks it, before anything is written', async () => {
		const { started } = install('managed-free');
		const error = await refusal(create('cust-unused'));
		expect(error.code).toBe('forbidden');
		expect(error.details).toMatchObject({
			requires: 'entitlement',
			reason: 'feature_not_included',
			unlockedBy: { id: 'managed-pro', name: 'Managed Pro' }
		});
		expect(started).toHaveLength(0);
	});

	it("refuses another organization's bundle as unknown", async () => {
		const { started } = install();
		const theirs = await upload(withMarker(), OTHER);
		const error = await refusal(create(theirs.bundleId));
		expect(error.code).toBe('unprocessable');
		expect(error.details).toEqual({ reason: 'bundle_unknown' });
		expect(started).toHaveLength(0);
	});

	it('needs a bundle for a custom site and allows one for no other kind', async () => {
		install();
		expect((await refusal(create(undefined))).details).toEqual({ field: 'bundleId' });
		const bundle = await upload(withMarker());
		expect((await refusal(create(bundle.bundleId, ORG, 'drupal'))).details).toEqual({
			field: 'bundleId'
		});
	});
});

describe('updating and rolling back a custom site', () => {
	it('starts an upgrade to the new bundle with the plain front-page check', async () => {
		const { started } = install();
		const first = await upload(withMarker());
		const siteId = await liveCustomSite(first.bundleId!);
		const second = await upload(withMarker({}, 'v2'), ORG, 'app-2.tar.gz');
		const operation = await upgradeSite(siteServices(), {
			orgId: ORG,
			siteId,
			bundleId: second.bundleId!,
			idempotencyKey: key()
		});
		expect(operation.operation.type).toBe('site.upgrade');
		const request = started.at(-1)!;
		expect(request.workflow).toBe('site-upgrade');
		expect(request.params).toMatchObject({
			releaseId: second.bundleId,
			currentRelease: first.bundleId,
			site: { kind: 'custom' },
			probe: { path: '/', expectStatus: 200 }
		});
		expect(JSON.stringify(request.params)).not.toContain(MARKER);
	});

	it('refuses an update that removes a class, changes the stores or repeats the running bundle', async () => {
		const { started } = install();
		const first = await upload(withMarker(DO_CONFIG));
		const siteId = await liveCustomSite(first.bundleId!);
		const before = started.length;
		const ask = (bundleId: string) =>
			upgradeSite(siteServices(), { orgId: ORG, siteId, bundleId, idempotencyKey: key() });

		const noClass = await upload(withMarker({ migrations: DO_CONFIG.migrations }, 'v2'));
		const removed = await refusal(ask(noClass.bundleId!));
		expect(removed.details).toEqual({ reason: 'migration_refused' });
		expect(removed.message).toContain('removes the Room class');

		const otherStores = await upload(
			withMarker({ ...DO_CONFIG, kv_namespaces: [{ binding: 'OTHER', id: 'x' }] }, 'v3')
		);
		expect((await refusal(ask(otherStores.bundleId!))).details).toEqual({
			reason: 'resources_changed'
		});

		expect((await refusal(ask(first.bundleId!))).details).toMatchObject({
			reason: 'up_to_date'
		});
		expect(started).toHaveLength(before);
	});

	it("refuses another organization's bundle and a missing bundle id", async () => {
		install();
		const first = await upload(withMarker());
		const siteId = await liveCustomSite(first.bundleId!);
		const theirs = await upload(withMarker({}, 'theirs'), OTHER);
		const ask = (bundleId: string | undefined) =>
			upgradeSite(siteServices(), { orgId: ORG, siteId, bundleId, idempotencyKey: key() });
		expect((await refusal(ask(theirs.bundleId!))).details).toEqual({
			reason: 'bundle_unknown'
		});
		expect((await refusal(ask(undefined))).details).toEqual({ field: 'bundleId' });
	});

	it('allows a rollback to the site own earlier bundle and lists both deploys with notes', async () => {
		install();
		const first = await upload(withMarker(), ORG, 'app.tar.gz');
		const siteId = await liveCustomSite(first.bundleId!);
		const second = await upload(withMarker({}, 'v2'), ORG, 'app-2.tar.gz');
		const db = await getDb();
		const verdict = await checkRollback(
			{ getDb },
			{ orgId: ORG, siteId, release: first.bundleId! }
		);
		expect(verdict).toMatchObject({ allowed: true, release: first.bundleId });
		for (const [id, release, at] of [
			['rev_cb_1', first.bundleId, 1],
			['rev_cb_2', second.bundleId, 2]
		] as const) {
			await env.DB.prepare(
				`INSERT INTO site_revisions (id, organization_id, site_id, kind, release_id, created_at)
				 VALUES (?, ?, ?, 'release', ?, ?)`
			)
				.bind(id, ORG, siteId, release, at)
				.run();
		}
		await env.DB.prepare('UPDATE sites SET release_id = ? WHERE id = ?')
			.bind(second.bundleId, siteId)
			.run();
		const { items } = await listRevisions({ getDb: async () => db }, { orgId: ORG, siteId });
		expect(items.map((item) => [item.release, item.note, item.current])).toEqual([
			[second.bundleId, `Uploaded app-2.tar.gz (${second.sha256.slice(0, 12)})`, true],
			[first.bundleId, `Uploaded app.tar.gz (${first.sha256.slice(0, 12)})`, false]
		]);
	});

	it("refuses a rollback to another organization's bundle and to a platform release", async () => {
		install();
		const first = await upload(withMarker());
		const siteId = await liveCustomSite(first.bundleId!);
		const theirs = await upload(withMarker({}, 'theirs'), OTHER);
		for (const release of [theirs.bundleId!, 'rel-any']) {
			const error = await refusal(checkRollback({ getDb }, { orgId: ORG, siteId, release }));
			expect(error.details).toEqual({ reason: 'release_unknown' });
		}
	});
});

describe('the routes', () => {
	const INTAKE = '/api/v1/orgs/:orgId/custom-bundles';
	const UPDATE = '/api/v1/orgs/:orgId/sites/:id/bundle';

	function asOwner() {
		setup({
			deps: {
				load: async (input) => ({
					resource: { orgId: ORG, departmentId: DEPT, siteId: input.params.id },
					facts: facts({ membership: { orgId: ORG, role: 'owner' }, ...fresh })
				})
			}
		});
	}

	const post = (raw: string, headers: Record<string, string> = {}) =>
		sendRequest(intake, INTAKE, {
			method: 'POST',
			path: `/api/v1/orgs/${ORG}/custom-bundles?fileName=app.tar.gz`,
			headers: { ...asUser, 'content-type': 'application/gzip', ...headers },
			raw
		});

	afterEach(() => resetApiDeps());

	it('refuses the free plan with 403 and the plan that unlocks custom code', async () => {
		install('managed-free');
		asOwner();
		const reply = await post('not an archive');
		expect(reply.status).toBe(403);
		expect(reply.text).toContain('"unlockedBy":{"id":"managed-pro","name":"Managed Pro"}');
	});

	it('refuses an Idempotency-Key and a body that is no archive', async () => {
		install();
		asOwner();
		expect((await post('x', { 'idempotency-key': key() })).status).toBe(400);
		const junk = await post('not an archive');
		expect(junk.status).toBe(422);
		expect(junk.text).toContain('archive_unreadable');
	});

	it('answers an update with 202 and refuses another organization bundle with 422', async () => {
		install();
		const first = await upload(withMarker());
		const siteId = await liveCustomSite(first.bundleId!);
		const second = await upload(withMarker({}, 'v2'));
		const theirs = await upload(withMarker({}, 'theirs'), OTHER);
		asOwner();
		const update = (bundleId: string, headers: Record<string, string>) =>
			sendRequest(bundle, UPDATE, {
				method: 'POST',
				path: `/api/v1/orgs/${ORG}/sites/${siteId}/bundle`,
				headers: { ...asUser, ...headers },
				json: { bundleId }
			});
		expect((await update(second.bundleId!, {})).status).toBe(400);
		const refused = await update(theirs.bundleId!, { 'idempotency-key': key() });
		expect(refused.status).toBe(422);
		expect(refused.text).toContain('bundle_unknown');
		const accepted = await update(second.bundleId!, { 'idempotency-key': key() });
		expect(accepted.status).toBe(202);
		expect(accepted.json).toMatchObject({ type: 'site.upgrade' });
	});
});
