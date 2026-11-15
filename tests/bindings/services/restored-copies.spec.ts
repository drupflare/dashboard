import type { D1Database } from '@cloudflare/workers-types';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import { getEnvironment, listEnvironments } from '../../../src/server/db/repos/environments';
import { derive } from '../../../src/server/domain/entitlements';
import { resetBackupServices, setBackupServices } from '../../../src/server/services/backups';
import { startPitr } from '../../../src/server/services/pitr';
import {
	startEnvCreate,
	startEnvDelete,
	startVerify
} from '../../../src/server/services/restored-copies';
import { resetSiteServices, setSiteServices } from '../../../src/server/services/sites';
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
async function site(label: string) {
	const id = `site_${label}${String(++counter).padStart(10, '0')}`;
	const backup = `bkp_${label}${String(counter).padStart(10, '0')}`;
	await db()
		.prepare(
			`INSERT INTO sites (id, organization_id, name, plane, state, account_id, category, config, kind,
			primary_hostname, ready_at, created_at, updated_at)
			VALUES (?, ?, ?, 'managed', 'active', ?, 'cms', 'managed', 'drupal', ?, ?, ?, ?)`
		)
		.bind(id, ORG, id, ACCOUNT, `${label}${counter}.drupflare.app`, NOW, NOW, NOW)
		.run();
	await db()
		.prepare(
			`INSERT INTO backups (id, site_id, organization_id, operation_id, bytes, sha256, parts,
			restorable, verified, label, created_at)
			VALUES (?, ?, ?, ?, 1024, 'abc', 1, 1, 0, NULL, ?)`
		)
		.bind(backup, id, ORG, `op_${backup}`, NOW)
		.run();
	return { id, backup, label: `${label}${counter}` };
}

function install(planId: string, ceiling = 1_000_000) {
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
			releases: { drupal: 'rel_1' }
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
			details: { feature: 'environments', unlockedBy: { id: 'managed-site' } }
		});
		expect(start).not.toHaveBeenCalled();
	});

	it('refuses a site with no backup to copy', async () => {
		const live = await site('nobk');
		await db().prepare('DELETE FROM backups WHERE site_id = ?').bind(live.id).run();
		install('managed-studio');
		await expect(startEnvCreate(create(live.id, 'k-nobk'))).rejects.toMatchObject({
			details: { reason: 'no_backup' }
		});
	});

	it('records the environment and its operation, starts env-create once and repeats on the same key', async () => {
		const live = await site('make');
		const start = install('managed-studio');

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
		install('managed-studio');
		await startEnvCreate(create(live.id, 'k-twin-1', 'dev'));
		await expect(startEnvCreate(create(live.id, 'k-twin-2', 'dev'))).rejects.toMatchObject({
			details: { reason: 'environment_exists' }
		});
		expect(await listEnvironments(await getDb(), ORG, live.id)).toHaveLength(1);
	});

	it('deletes only an environment that is ready or failed', async () => {
		const live = await site('gone');
		const start = install('managed-studio');
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
		install('managed-studio');
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
