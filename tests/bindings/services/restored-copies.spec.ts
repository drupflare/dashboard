import type { D1Database } from '@cloudflare/workers-types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getEnvironment, listEnvironments } from '../../../src/server/db/repos/environments';
import { derive } from '../../../src/server/domain/entitlements';
import { resetBackupServices, setBackupServices } from '../../../src/server/services/backups';
import { startPitr } from '../../../src/server/services/pitr';
import {
	runRestoreDrills,
	startEnvCreate,
	startEnvDelete,
	startVerify,
	sweepExpiredEnvironments
} from '../../../src/server/services/restored-copies';
import { resetSiteServices, setSiteServices } from '../../../src/server/services/sites';
import {
	HOUR_MS,
	PREVIEW_LIMIT,
	PREVIEW_TTL_DEFAULT_MS,
	PREVIEW_TTL_MAX_MS
} from '../../../src/shared/environments';
import { ORG } from '../../unit/domain/fixtures';
import { openBindings, type Bindings, type OpenBindings } from '../support';

const ACCOUNT = 'a'.repeat(32);
const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

let harness: OpenBindings;
let env: Bindings;
const db = () => env.DB as D1Database;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await getDb();
});

afterAll(() => harness.close());

afterEach(() => {
	resetSiteServices();
	resetBackupServices();
});

let counter = 0;

// a live site with its host and one backup that a restore accepts
async function site(label: string, org: string = ORG) {
	const id = `site_${label}${String(++counter).padStart(10, '0')}`;
	const backup = `bkp_${label}${String(counter).padStart(10, '0')}`;
	await db()
		.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, account_id, category, config, kind,
			primary_hostname, ready_at, created_at, updated_at)
			VALUES (?, ?, ?, 'managed', 'active', ?, 'cms', 'managed', 'drupal', ?, ?, ?, ?)`
		)
		.bind(id, org, id, ACCOUNT, `${label}${counter}.drupflare.app`, NOW, NOW, NOW)
		.run();
	await db()
		.prepare(
			`INSERT INTO backups (id, site_id, organization_id, operation_id, bytes, sha256, parts,
			restorable, verified, label, created_at)
			VALUES (?, ?, ?, ?, 1024, 'abc', 1, 1, 0, NULL, ?)`
		)
		.bind(backup, id, org, `op_${backup}`, NOW)
		.run();
	return { id, backup, label: `${label}${counter}` };
}

function install(planId: string, ceiling = 1_000_000, restoreDrills?: boolean) {
	const startOperation = vi.fn(async () => undefined);
	const result = derive(planId);
	if (!result.ok) throw new Error(result.reason);
	setSiteServices({
		getDb,
		planOf: async () => result.entitlement,
		startOperation,
		config: {
			hostSuffix: 'drupflare.app',
			labelSuffix: '',
			accountId: ACCOUNT,
			releases: { drupal: 'rel_1' },
			...(restoreDrills === undefined ? {} : { restoreDrills })
		}
	});
	setBackupServices({ getDb, restoreCeilingBytes: ceiling });
	return startOperation;
}

const create = (siteId: string, key: string, kind: 'staging' | 'dev' = 'staging') => ({
	orgId: ORG,
	siteId,
	kind,
	userId: 'usr_1',
	idempotencyKey: key
});

describe('environments over real D1', () => {
	it('refuses a plan without environments and names the plan that has them', async () => {
		const live = await site('free');
		const start = install('managed-free');
		await expect(startEnvCreate(create(live.id, 'k-free'))).rejects.toMatchObject({
			code: 'forbidden',
			details: { feature: 'environments', unlockedBy: { id: 'managed-pro' } }
		});
		expect(start).not.toHaveBeenCalled();
	});

	it('refuses a site with no backup to copy', async () => {
		const live = await site('nobk');
		await db().prepare('DELETE FROM backups WHERE site_id = ?').bind(live.id).run();
		install('managed-pro');
		await expect(startEnvCreate(create(live.id, 'k-nobk'))).rejects.toMatchObject({
			details: { reason: 'no_backup' }
		});
	});

	it('records the environment and its operation, starts env-create once and repeats on the same key', async () => {
		const live = await site('make');
		const start = install('managed-pro');

		const first = await startEnvCreate(create(live.id, 'k-make'));
		const again = await startEnvCreate(create(live.id, 'k-make'));

		expect(first.environment).toMatchObject({
			kind: 'staging',
			name: `${live.label}-staging`,
			host: `${live.label}-staging.drupflare.app`,
			status: 'creating',
			sourceBackupId: live.backup
		});
		expect(first.operation.operation.type).toBe('env.create');
		expect(again.environment.id).toBe(first.environment.id);
		expect(again.operation.operation.id).toBe(first.operation.operation.id);
		expect(start).toHaveBeenCalledTimes(1);
		expect(start.mock.calls[0]?.[0]).toMatchObject({ workflow: 'env-create' });
		const copy = await db()
			.prepare('SELECT ready_at FROM sites WHERE id = ?')
			.bind(first.environment.envSiteId)
			.first<{ ready_at: number | null }>();
		expect(copy?.ready_at).toBeNull();
	});

	it('refuses a second live environment of the same kind and leaves the first alone', async () => {
		const live = await site('twin');
		install('managed-pro');
		await startEnvCreate(create(live.id, 'k-twin-1', 'dev'));
		await expect(startEnvCreate(create(live.id, 'k-twin-2', 'dev'))).rejects.toMatchObject({
			details: { reason: 'environment_exists' }
		});
		expect(await listEnvironments(await getDb(), ORG, live.id)).toHaveLength(1);
	});

	it('deletes only an environment that is ready or failed', async () => {
		const live = await site('gone');
		const start = install('managed-pro');
		const { environment } = await startEnvCreate(create(live.id, 'k-gone'));
		const request = {
			orgId: ORG,
			siteId: live.id,
			environmentId: environment.id,
			idempotencyKey: 'd-gone'
		};
		await expect(startEnvDelete(request)).rejects.toMatchObject({
			details: { reason: 'environment_busy' }
		});

		await db()
			.prepare("UPDATE site_environments SET status = 'ready' WHERE id = ?")
			.bind(environment.id)
			.run();
		await db()
			.prepare("UPDATE operations SET status = 'succeeded' WHERE site_id = ?")
			.bind(environment.envSiteId)
			.run();
		const operation = await startEnvDelete(request);

		expect(operation.operation.type).toBe('env.delete');
		expect((await getEnvironment(await getDb(), ORG, live.id, environment.id))?.status).toBe(
			'deleting'
		);
		expect(start.mock.calls.at(-1)?.[0]).toMatchObject({ workflow: 'env-delete' });
	});

	it('answers not found for an environment the site does not have', async () => {
		const live = await site('none');
		install('managed-pro');
		await expect(
			startEnvDelete({
				orgId: ORG,
				siteId: live.id,
				environmentId: `env_${'z'.repeat(20)}`,
				idempotencyKey: 'd-none'
			})
		).rejects.toMatchObject({ code: 'not_found' });
	});
});

describe('previews over real D1', () => {
	const preview = (siteId: string, key: string, ttlMs?: number) => ({
		orgId: ORG,
		siteId,
		kind: 'preview' as const,
		userId: 'usr_1',
		idempotencyKey: key,
		...(ttlMs === undefined ? {} : { ttlMs })
	});

	it('numbers previews from one, gives each the default expiry and refuses past the limit', async () => {
		const live = await site('prev');
		install('managed-pro');
		const before = Date.now();
		const made = [];
		for (let n = 1; n <= PREVIEW_LIMIT; n++) {
			made.push((await startEnvCreate(preview(live.id, `k-prev-${n}`))).environment);
		}

		expect(made.map((row) => row.name)).toEqual(
			[1, 2, 3].map((n) => `${live.label}-preview-${n}`)
		);
		for (const row of made) {
			expect(row.ttlAt).toBeGreaterThanOrEqual(before + PREVIEW_TTL_DEFAULT_MS);
			expect(row.ttlAt).toBeLessThanOrEqual(Date.now() + PREVIEW_TTL_DEFAULT_MS);
		}
		await expect(startEnvCreate(preview(live.id, 'k-prev-4'))).rejects.toMatchObject({
			details: { reason: 'preview_limit' }
		});
		const repeat = await startEnvCreate(preview(live.id, `k-prev-${PREVIEW_LIMIT}`));
		expect(repeat.environment.id).toBe(made.at(-1)?.id);
	});

	it('keeps an expiry between an hour and the ceiling', async () => {
		const live = await site('clamp');
		install('managed-pro');
		const before = Date.now();
		const short = await startEnvCreate(preview(live.id, 'k-clamp-1', 1));
		const long = await startEnvCreate(preview(live.id, 'k-clamp-2', 400 * 24 * HOUR_MS));

		expect(short.environment.ttlAt! - before).toBeGreaterThanOrEqual(HOUR_MS);
		expect(short.environment.ttlAt! - before).toBeLessThan(HOUR_MS + 60_000);
		expect(long.environment.ttlAt! - before).toBeGreaterThanOrEqual(PREVIEW_TTL_MAX_MS);
		expect(long.environment.ttlAt! - before).toBeLessThan(PREVIEW_TTL_MAX_MS + 60_000);
	});

	it('refuses a plan without previews', async () => {
		const live = await site('nopv');
		install('managed-free');
		await expect(startEnvCreate(preview(live.id, 'k-nopv'))).rejects.toMatchObject({
			code: 'forbidden'
		});
	});

	it('deletes an expired preview once, and leaves a live preview and a staging copy alone', async () => {
		const live = await site('swp');
		const start = install('managed-pro');
		const expired = (await startEnvCreate(preview(live.id, 'k-swp-1'))).environment;
		const fresh = (await startEnvCreate(preview(live.id, 'k-swp-2'))).environment;
		const staging = (await startEnvCreate(create(live.id, 'k-swp-3'))).environment;
		await db()
			.prepare("UPDATE site_environments SET status = 'ready' WHERE site_id = ?")
			.bind(live.id)
			.run();
		await db()
			.prepare(
				`UPDATE operations SET status = 'succeeded' WHERE site_id IN
				 (SELECT env_site_id FROM site_environments WHERE site_id = ?)`
			)
			.bind(live.id)
			.run();
		await db()
			.prepare('UPDATE site_environments SET ttl_at = ? WHERE id = ?')
			.bind(NOW, expired.id)
			.run();

		const swept = await sweepExpiredEnvironments(Date.now());
		const again = await sweepExpiredEnvironments(Date.now());

		expect(swept).toEqual({ expired: 1, started: [expired.id], failed: [] });
		expect(again.expired).toBe(0);
		const status = async (id: string) =>
			(await getEnvironment(await getDb(), ORG, live.id, id))?.status;
		expect(await status(expired.id)).toBe('deleting');
		expect(await status(fresh.id)).toBe('ready');
		expect(await status(staging.id)).toBe('ready');
		expect(start.mock.calls.filter(([call]) => call.workflow === 'env-delete')).toHaveLength(1);
	});
});

describe('backup verification over real D1', () => {
	const verify = (siteId: string, backupId: string) => ({
		orgId: ORG,
		siteId,
		backupId,
		userId: 'usr_1',
		idempotencyKey: `v-${backupId}`
	});

	it('starts backup-verify and keeps the scratch site hidden', async () => {
		const live = await site('vfy');
		const start = install('managed-free');
		const operation = await startVerify(verify(live.id, live.backup));

		expect(operation.operation.type).toBe('backup.verify');
		expect(start.mock.calls[0]?.[0]).toMatchObject({ workflow: 'backup-verify' });
		const hidden = await db()
			.prepare(
				'SELECT count(*) AS n FROM sites WHERE id != ? AND ready_at IS NULL AND name LIKE ?'
			)
			.bind(live.id, '%Test Restore%')
			.first<{ n: number }>();
		expect(hidden?.n).toBeGreaterThanOrEqual(1);
	});

	it('answers not found for a backup the site does not have', async () => {
		const live = await site('vnf');
		install('managed-free');
		await expect(startVerify(verify(live.id, `bkp_${'9'.repeat(20)}`))).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('refuses a backup larger than a restore accepts', async () => {
		const live = await site('big');
		install('managed-free', 10);
		await expect(startVerify(verify(live.id, live.backup))).rejects.toMatchObject({
			details: { reason: 'not_restorable' }
		});
	});
});

describe('restore drills over real D1', () => {
	const WEEK = 7 * DAY;

	beforeAll(async () => {
		await db()
			.prepare(
				`INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at, updated_at)
				VALUES ('mem_drill', ?, 'usr_owner', 'owner', ?, ?)`
			)
			.bind(ORG, NOW, NOW)
			.run();
	});

	it('starts one drill per tick, each site once, and then has nothing due', async () => {
		await site('drl');
		await site('drl');
		const start = install('managed-free');
		const first = await runRestoreDrills(NOW);
		expect(first.due).toBeGreaterThanOrEqual(2);
		expect(first.started).toHaveLength(1);

		const seen = new Set(first.started);
		for (let tick = 0; tick < first.due; tick++) {
			const next = await runRestoreDrills(NOW);
			for (const id of next.started) {
				expect(seen.has(id), id).toBe(false);
				seen.add(id);
			}
			if (next.started.length === 0) break;
		}
		expect(seen.size).toBe(first.due);
		expect(start.mock.calls.filter(([call]) => call.workflow === 'backup-verify')).toHaveLength(
			first.due
		);
		expect(await runRestoreDrills(NOW)).toMatchObject({ due: 0, started: [], failed: [] });
	});

	it('tests the newest backup again once the week has passed', async () => {
		install('managed-free');
		const later = Date.now() + WEEK + DAY;
		const summary = await runRestoreDrills(later);
		expect(summary.due).toBeGreaterThanOrEqual(1);
		expect(summary.started).toHaveLength(1);
	});

	it('starts nothing when RESTORE_DRILLS is off', async () => {
		const start = install('managed-free', 1_000_000, false);
		const summary = await runRestoreDrills(Date.now() + 3 * WEEK);
		expect(summary).toMatchObject({ due: 0, started: [], failed: [] });
		expect(summary.skipped).toBeDefined();
		expect(start).not.toHaveBeenCalled();
	});

	it('leaves a backup above the restore ceiling alone', async () => {
		const start = install('managed-free', 10);
		const summary = await runRestoreDrills(Date.now() + 3 * WEEK);
		expect(summary).toMatchObject({ due: 0, started: [], failed: [] });
		expect(start).not.toHaveBeenCalled();
	});

	it('reports a site whose organization has no owner and still drills the next one', async () => {
		const orphan = await site('aaa', 'org-noowner');
		install('managed-free');
		const summary = await runRestoreDrills(Date.now() + 3 * WEEK);
		expect(summary.failed).toEqual([
			{ siteId: orphan.id, message: 'the organization has no owner' }
		]);
		expect(summary.started).toHaveLength(1);
		await db().prepare('DELETE FROM backups WHERE site_id = ?').bind(orphan.id).run();
		await db().prepare('DELETE FROM sites WHERE id = ?').bind(orphan.id).run();
	});
});

describe('point-in-time restore over real D1', () => {
	it('schedules for a moment inside the window', async () => {
		const live = await site('pit');
		const start = install('managed-free');
		const operation = await startPitr({
			orgId: ORG,
			siteId: live.id,
			at: Date.now() - 3 * DAY,
			idempotencyKey: 'p-ok'
		});
		expect(operation.operation.type).toBe('site.restore');
		expect(start.mock.calls[0]?.[0]).toMatchObject({ workflow: 'site-pitr' });
	});

	it.each([
		['a future moment', () => Date.now() + DAY],
		['a moment past the 30 day window', () => Date.now() - 31 * DAY]
	])('refuses %s', async (_name, at) => {
		const live = await site('pbad');
		const start = install('managed-free');
		await expect(
			startPitr({ orgId: ORG, siteId: live.id, at: at(), idempotencyKey: `p-${_name}` })
		).rejects.toMatchObject({ details: { reason: 'outside_window' } });
		expect(start).not.toHaveBeenCalled();
	});
});
