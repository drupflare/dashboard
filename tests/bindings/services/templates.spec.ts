import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { D1TemplateStore } from '../../../engine/src/adapters/templates';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { beginTemplateBuild } from '../../../src/server/db/repos/template-bundles';
import { FREE_PLAN_ID, derive } from '../../../src/server/domain/entitlements';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import { resetPendingSecretDeps } from '../../../src/server/services/owner-tokens';
import {
	createSite,
	resetSiteServices,
	setSiteServices,
	siteServices
} from '../../../src/server/services/sites';
import {
	BUILD_STALE_MS,
	listTemplates,
	startTemplateBuild,
	templateForCreate
} from '../../../src/server/services/templates';
import { ApiError } from '../../../src/shared/errors';
import {
	FREE_DAILY_ROWS,
	TEMPLATE_HELD_REASON,
	TEMPLATE_HELD_TITLE,
	templateCommit,
	templateSpec
} from '../../../src/shared/template-entries';
import { ORG } from '../../unit/domain/fixtures';
import { installPendingSecrets, openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
});

afterAll(() => harness.close());

beforeEach(async () => {
	await getDb();
	await env.DB.prepare('DELETE FROM template_bundles').run();
});

afterEach(() => {
	resetSiteServices();
	resetPendingSecretDeps();
});

const CONFIG = {
	hostSuffix: 'drupflare.app',
	accountId: 'a'.repeat(32),
	releases: { drupal: 'v1.0.4', smoke: 'v1.0.4' }
};

const entitlementOf = (planId: string) => {
	const result = derive(planId);
	if (!result.ok) throw new Error(result.reason);
	return result.entitlement;
};

function port(planId = FREE_PLAN_ID) {
	const started: EngineStartRequest[] = [];
	installPendingSecrets(getDb, () => 1_000_000);
	setSiteServices({
		getDb,
		entitlements: { check: async () => ({ allow: true, entitlement: entitlementOf(planId) }) },
		startOperation: async (request) => void started.push(request),
		config: CONFIG
	});
	return started;
}

// a ready row, written the way the engine marks one
async function ready(
	entryId: string,
	over: { rows?: number; databaseBytes?: number; commit?: string; at?: number } = {}
) {
	const commit = over.commit ?? templateCommit(entryId as 'thunder');
	const id = `tpl_${entryId}_${Math.random().toString(36).slice(2, 10)}`;
	await beginTemplateBuild(await getDb(), { id, entryId, commit, now: over.at ?? Date.now() });
	const manifest = {
		version: 1,
		entryId,
		commit,
		phpVersion: '8.4.27',
		buildSeconds: 5,
		rows: over.rows ?? 2656,
		advisories: [{ id: 'SA-CORE-2026-014', package: 'drupal/core' }],
		patchesFailed: [{ package: 'drupal/pathauto', patch: 'https://drupal.test/p.diff' }],
		packages: 161,
		sections: [
			{ name: 'database.sql', bytes: over.databaseBytes ?? 10, sha256: '0'.repeat(64) }
		]
	};
	await new D1TemplateStore(env.DB as never).ready(id, {
		bundleKey: `templates/${entryId}/${id}/bundle`,
		manifest: JSON.stringify(manifest)
	});
	return { id, key: `templates/${entryId}/${id}/bundle` };
}

// the create gate is open in these specs; the default holds every template until code delivery exists
const delivered = () => ({ ...siteServices(), templateCodeDelivery: true });

describe('listTemplates', () => {
	it('lists all three entries as not built before any build', async () => {
		port();
		const items = await listTemplates(delivered());
		expect(items.map((item) => [item.id, item.state, item.usable])).toEqual([
			['thunder', 'not_built', false],
			['govcms', 'not_built', false],
			['farmos', 'not_built', false]
		]);
		expect(items[0]?.reason).toBe('This template has not been built yet.');
	});

	it('shows a ready build with its advisories, failed patch and fit', async () => {
		port();
		await ready('thunder');
		const [thunder] = await listTemplates(delivered());
		expect(thunder).toMatchObject({
			state: 'ready',
			usable: true,
			reason: null,
			advisories: [{ id: 'SA-CORE-2026-014', package: 'drupal/core' }],
			patchNotes: [{ package: 'drupal/pathauto', patch: 'https://drupal.test/p.diff' }],
			fit: { fits: true, rows: 2656, limit: FREE_DAILY_ROWS, percent: 3 }
		});
	});

	it('shows a build in progress and a failed build with plain reasons', async () => {
		port();
		await beginTemplateBuild(await getDb(), {
			id: 'tpl_building1',
			entryId: 'govcms',
			commit: templateCommit('govcms'),
			now: Date.now()
		});
		await beginTemplateBuild(await getDb(), {
			id: 'tpl_failed001',
			entryId: 'farmos',
			commit: templateCommit('farmos'),
			now: Date.now()
		});
		await new D1TemplateStore(env.DB as never).fail('tpl_failed001', 'composer stopped');
		const items = await listTemplates(delivered());
		expect(items.find((item) => item.id === 'govcms')).toMatchObject({
			state: 'building',
			reason: 'This template is being built.'
		});
		expect(items.find((item) => item.id === 'farmos')).toMatchObject({
			state: 'failed',
			reason: 'The last build of this template failed.'
		});
	});

	it('does not offer a build of an older corpus pin', async () => {
		port();
		await ready('thunder', { commit: 'e'.repeat(40) });
		const [thunder] = await listTemplates(delivered());
		expect(thunder).toMatchObject({ state: 'not_built', usable: false });
		expect(thunder?.reason).toContain('changed');
	});

	it('marks a ready template that is over the free daily rows and one over the restore ceiling', async () => {
		port();
		await ready('thunder', { rows: FREE_DAILY_ROWS + 1 });
		await ready('govcms', { databaseBytes: 16 * 1024 * 1024 + 1 });
		const items = await listTemplates(delivered());
		const thunder = items.find((item) => item.id === 'thunder');
		expect(thunder?.usable).toBe(true);
		expect(thunder?.fit?.fits).toBe(false);
		expect(thunder?.reason).toContain('Free plan allows 100,000 a day');
		const govcms = items.find((item) => item.id === 'govcms');
		expect(govcms).toMatchObject({ usable: false });
		expect(govcms?.reason).toContain('A larger restore path is not available yet');
	});

	it('holds every template with the update reason while code delivery is off', async () => {
		port();
		await ready('thunder');
		const items = await listTemplates(siteServices());
		expect(items.map((item) => [item.id, item.usable, item.reason])).toEqual([
			['thunder', false, TEMPLATE_HELD_REASON],
			['govcms', false, TEMPLATE_HELD_REASON],
			['farmos', false, TEMPLATE_HELD_REASON]
		]);
		expect(items[0]).toMatchObject({
			state: 'ready',
			advisories: [{ id: 'SA-CORE-2026-014', package: 'drupal/core' }],
			fit: { fits: true }
		});
	});

	it('falls back to not built when the store is not installed', async () => {
		const items = await listTemplates(delivered());
		expect(items.every((item) => item.state === 'not_built')).toBe(true);
	});

	it('does not hide any other store error', async () => {
		await expect(
			listTemplates({
				getDb: async () => {
					throw new Error('store is down');
				}
			})
		).rejects.toThrow('store is down');
	});
});

describe('startTemplateBuild', () => {
	it('records a building row and starts the build workflow with the job spec', async () => {
		const started = port();
		const { buildId } = await startTemplateBuild(siteServices(), 'thunder');
		expect(started).toHaveLength(1);
		expect(started[0]).toMatchObject({
			workflow: 'template-build',
			id: buildId,
			params: {
				buildId,
				entryId: 'thunder',
				commit: templateCommit('thunder'),
				spec: templateSpec('thunder')
			}
		});
		const row = await env.DB.prepare(
			'SELECT status, commit_sha FROM template_bundles WHERE id = ?'
		)
			.bind(buildId)
			.first();
		expect(row).toEqual({ status: 'building', commit_sha: templateCommit('thunder') });
	});

	it('refuses a second build of the same template while one is running', async () => {
		port();
		await startTemplateBuild(siteServices(), 'thunder');
		const error = await startTemplateBuild(siteServices(), 'thunder').catch((e: unknown) => e);
		expect(error).toMatchObject({ code: 'conflict' });
		await expect(startTemplateBuild(siteServices(), 'farmos')).resolves.toBeDefined();
	});

	it('starts again over a build whose workflow died long ago', async () => {
		port();
		await beginTemplateBuild(await getDb(), {
			id: 'tpl_stale0001',
			entryId: 'thunder',
			commit: templateCommit('thunder'),
			now: Date.now() - BUILD_STALE_MS - 1000
		});
		await expect(startTemplateBuild(siteServices(), 'thunder')).resolves.toBeDefined();
	});

	it('marks the row failed and answers unprocessable when the start is refused', async () => {
		port();
		setSiteServices({
			startOperation: async () => {
				throw new Error('refused');
			}
		});
		const error = await startTemplateBuild(siteServices(), 'govcms').catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect(error).toMatchObject({ code: 'unprocessable' });
		const row = await env.DB.prepare('SELECT status, failure FROM template_bundles').first();
		expect(row).toMatchObject({ status: 'failed', failure: 'The build could not start.' });
	});

	it('refuses an entry that is not a template', async () => {
		port();
		await expect(startTemplateBuild(siteServices(), 'wordpress')).rejects.toMatchObject({
			code: 'not_found'
		});
	});
});

describe('templateForCreate', () => {
	it('returns the key of a ready build at the pinned commit', async () => {
		port();
		const { key } = await ready('thunder');
		await expect(templateForCreate(siteServices(), 'thunder', FREE_PLAN_ID)).resolves.toEqual({
			entryId: 'thunder',
			commit: templateCommit('thunder'),
			bundleKey: key
		});
	});

	it('uses the newest ready build', async () => {
		port();
		await ready('thunder', { at: 1000 });
		const newest = await ready('thunder', { at: 2000 });
		const chosen = await templateForCreate(siteServices(), 'thunder', FREE_PLAN_ID);
		expect(chosen.bundleKey).toBe(newest.key);
	});

	it.each([
		['no build', async () => undefined],
		[
			'a build still running',
			async () =>
				beginTemplateBuild(await getDb(), {
					id: 'tpl_running01',
					entryId: 'thunder',
					commit: templateCommit('thunder'),
					now: Date.now()
				})
		],
		[
			'a ready build of an older pin',
			async () => void (await ready('thunder', { commit: 'f'.repeat(40) }))
		]
	])('refuses %s', async (_name, arrange) => {
		port();
		await arrange();
		await expect(
			templateForCreate(siteServices(), 'thunder', FREE_PLAN_ID)
		).rejects.toMatchObject({
			code: 'unprocessable',
			details: { reason: 'template_not_ready' }
		});
	});

	it('refuses a failed build', async () => {
		port();
		await beginTemplateBuild(await getDb(), {
			id: 'tpl_failed002',
			entryId: 'thunder',
			commit: templateCommit('thunder'),
			now: Date.now()
		});
		await new D1TemplateStore(env.DB as never).fail('tpl_failed002', 'x');
		await expect(
			templateForCreate(siteServices(), 'thunder', FREE_PLAN_ID)
		).rejects.toMatchObject({
			details: { reason: 'template_not_ready' }
		});
	});

	it('refuses a template over the free daily rows on the free plan and allows it on a paid plan', async () => {
		port();
		await ready('thunder', { rows: FREE_DAILY_ROWS + 1 });
		await expect(
			templateForCreate(siteServices(), 'thunder', FREE_PLAN_ID)
		).rejects.toMatchObject({
			details: { reason: 'template_plan' }
		});
		await expect(
			templateForCreate(siteServices(), 'thunder', 'managed-site')
		).resolves.toMatchObject({
			entryId: 'thunder'
		});
	});

	it('refuses a database above the restore ceiling on every plan, with the plain reason', async () => {
		port();
		await ready('govcms', { databaseBytes: 16 * 1024 * 1024 + 1 });
		for (const plan of [FREE_PLAN_ID, 'managed-site']) {
			const error = await templateForCreate(siteServices(), 'govcms', plan).catch(
				(e: unknown) => e
			);
			expect(error).toMatchObject({ details: { reason: 'template_too_large' } });
			expect((error as ApiError).message).toBe(
				'This template is larger than a new site can restore. A larger restore path is not available yet.'
			);
		}
	});

	it('refuses an id that is not a template', async () => {
		port();
		await expect(
			templateForCreate(siteServices(), 'drupal', FREE_PLAN_ID)
		).rejects.toMatchObject({
			code: 'validation'
		});
	});
});

describe('createSite from a template', () => {
	const input = (over: Record<string, unknown> = {}) => ({
		orgId: ORG,
		userId: 'user-bindings',
		kind: 'drupal' as const,
		name: `template-site-${Math.random().toString(36).slice(2, 8)}`,
		hostnameLabel: undefined,
		idempotencyKey: `key-${Math.random()}`,
		...over
	});

	it('starts the create with the template and keeps it in the stored inputs', async () => {
		const started = port();
		const { key } = await ready('farmos');
		const stored = await createSite(delivered(), input({ templateEntryId: 'farmos' }));
		expect(started[0]?.workflow).toBe('site-create');
		expect(started[0]?.params).toMatchObject({
			template: { entryId: 'farmos', commit: templateCommit('farmos'), bundleKey: key }
		});
		expect(stored.operation.steps.map((step) => step.id)).toContain('template-restore');
	});

	it('refuses a template that is not built before anything is reserved', async () => {
		const started = port();
		const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{
			n: number;
		}>();
		await expect(
			createSite(delivered(), input({ templateEntryId: 'govcms' }))
		).rejects.toMatchObject({ details: { reason: 'template_not_ready' } });
		const after = await env.DB.prepare('SELECT COUNT(*) AS n FROM sites').first<{
			n: number;
		}>();
		expect(after?.n).toBe(before?.n);
		expect(started).toEqual([]);
	});

	it('holds a template before anything is reserved while code delivery is off', async () => {
		const started = port();
		await ready('thunder');
		await expect(
			createSite(siteServices(), input({ templateEntryId: 'thunder' }))
		).rejects.toMatchObject({
			code: 'unprocessable',
			message: TEMPLATE_HELD_REASON,
			details: { reason: 'template_code_delivery', title: TEMPLATE_HELD_TITLE }
		});
		expect(started).toEqual([]);
	});

	it('refuses a template for a site that is not Drupal', async () => {
		port();
		await ready('thunder');
		await expect(
			createSite(delivered(), input({ kind: 'smoke', templateEntryId: 'thunder' }))
		).rejects.toMatchObject({ code: 'validation', details: { field: 'templateEntryId' } });
	});

	it('leaves an ordinary create without template steps', async () => {
		const started = port();
		const stored = await createSite(siteServices(), input());
		expect(started[0]?.params).not.toHaveProperty('template');
		expect(stored.operation.steps.map((step) => step.id)).not.toContain('template-restore');
	});
});
