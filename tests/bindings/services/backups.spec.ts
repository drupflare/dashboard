import type { D1Database, R2Bucket } from '@cloudflare/workers-types';
import type { EventHandler } from 'h3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { D1BackupLedger, r2BackupBlobs } from '../../../engine/src/adapters/backups';
import {
	backupKeys,
	buildManifest,
	describePart,
	manifestDigest,
	type BackupRecord
} from '../../../engine/src/backup-parts';
import backupExport from '../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/[backupId]/export.get';
import backupRestore from '../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/[backupId]/restore.post';
import backupsList from '../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/index.get';
import backupsCreate from '../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/index.post';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import type { EngineStartRequest } from '../../../src/server/integrations/engine';
import {
	backupServicesOf,
	resetBackupServices,
	setBackupServices
} from '../../../src/server/services/backups';
import { resetApiDeps } from '../../../src/server/utils/define-api';
import { DEPT, ORG, OTHER_ORG, facts, fresh } from '../../unit/domain/fixtures';
import {
	asKey,
	asUser,
	send as sendRequest,
	setup,
	type Reply,
	type Request as RequestInit
} from '../../unit/server/fixtures/harness';
import { openBindings, type Bindings, type OpenBindings } from '../support';

const SITE = `site_${'a'.repeat(20)}`;
const TARGET = `site_${'b'.repeat(20)}`;
const FOREIGN = `site_${'f'.repeat(20)}`;
const BACKUP = `bkp_${'1'.repeat(20)}`;
const BIG = `bkp_${'2'.repeat(20)}`;
const THEIRS = `bkp_${'3'.repeat(20)}`;
const ACCOUNT = 'a'.repeat(32);
const DUMP = [
	'INSERT INTO t VALUES (1);\n',
	'INSERT INTO t VALUES (2);\n',
	'INSERT INTO t VALUES (3);\n'
];
const CEILING = 1_000;

let harness: OpenBindings;
let env: Bindings;
const db = () => env.DB as D1Database;
const getDb = () => ensureCollegeDB(withAtomicBatch(env));
const bucket = () => env.BLOB as R2Bucket;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await getDb();
	const now = 1_790_000_000_000;
	const site = (id: string, org: string, host: string, state = 'active') =>
		db()
			.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, account_id, category, config, kind,
				primary_hostname, ready_at, created_at, updated_at)
				VALUES (?, ?, ?, 'managed', ?, ?, 'cms', 'managed', 'drupal', ?, ?, ?, ?)`
			)
			.bind(id, org, id, state, ACCOUNT, host, now, now, now)
			.run();
	await site(SITE, ORG, 'a.drupflare.app');
	await site(TARGET, ORG, 'b.drupflare.app');
	await site(FOREIGN, OTHER_ORG, 'f.drupflare.app');
	await keep(BACKUP, SITE, ORG, DUMP, 1);
	await keep(BIG, SITE, ORG, DUMP, 2, { restorable: false, bytes: 5 * CEILING });
	await keep(THEIRS, FOREIGN, OTHER_ORG, DUMP, 3);
});

afterAll(() => harness.close());

afterEach(() => {
	resetBackupServices();
	resetApiDeps();
});

// writes the parts and manifest to the bucket and the row to the table, the way the engine does
async function keep(
	id: string,
	siteId: string,
	orgId: string,
	parts: string[],
	order: number,
	patch: Partial<BackupRecord> = {}
) {
	const blobs = r2BackupBlobs(bucket());
	const described = [];
	for (const [seq, text] of parts.entries()) {
		const bytes = new TextEncoder().encode(text);
		await blobs.put(backupKeys.part(orgId, siteId, id, seq), bytes);
		described.push(await describePart(seq, bytes));
	}
	const manifest = buildManifest({ id, orgId, siteId, parts: described });
	await blobs.put(
		backupKeys.manifest(orgId, siteId, id),
		new TextEncoder().encode(JSON.stringify(manifest))
	);
	await new D1BackupLedger(db()).record({
		id,
		siteId,
		organizationId: orgId,
		operationId: `op_${id.slice(4)}`,
		bytes: manifest.bytes,
		sha256: await manifestDigest(manifest),
		parts: parts.length,
		restorable: true,
		verified: false,
		label: null,
		createdAt: 1_790_000_000_000 + order,
		deletedAt: null,
		...patch
	});
}

const send = (
	handler: EventHandler,
	route: string,
	req: Partial<RequestInit> = {}
): Promise<Reply> => sendRequest(handler, route, { path: route, ...req });

function asMember(orgId = ORG, scopes: string[] = []) {
	return setup({
		deps: {
			load: async (input) => ({
				resource: { orgId, departmentId: DEPT },
				facts: {
					...facts({ membership: { orgId, role: 'owner' }, ...fresh }),
					...(input.principal.kind === 'key'
						? { key: { id: 'key-1', scopes: ['site.backup.export', ...scopes] } }
						: {})
				}
			})
		}
	});
}

function services(options: { audits?: unknown[]; refuse?: boolean } = {}) {
	const started: EngineStartRequest[] = [];
	const audits = options.audits ?? [];
	setBackupServices({
		...backupServicesOf(
			{ BLOB: bucket() },
			{
				getDb,
				startOperation: async (request) => {
					if (options.refuse) throw new Error('signed request refused');
					started.push(request);
				}
			},
			{ get: async () => null, put: async () => true },
			{ restoreCeilingBytes: CEILING, waitMs: 90_000, pollMs: 2_000 }
		),
		audit: async (_org, input) => void audits.push(input)
	});
	return { started, audits };
}

const base = (orgId: string, siteId: string) => `/api/v1/orgs/${orgId}/sites/${siteId}/backups`;
let counter = 0;
const key = () => ({ 'idempotency-key': `key-${++counter}-${Date.now()}` });
const ROUTE = '/api/v1/orgs/:orgId/sites/:siteId/backups';

describe('D1BackupLedger over real D1', () => {
	it('reads a site, filters a backup by organisation and keeps one row per operation', async () => {
		const ledger = new D1BackupLedger(db());
		expect(await ledger.site(SITE)).toMatchObject({
			organizationId: ORG,
			accountId: ACCOUNT,
			state: 'active',
			primaryHostname: 'a.drupflare.app'
		});
		expect(await ledger.site('site_nothere1')).toBeNull();
		expect((await ledger.get(ORG, BACKUP))?.parts).toBe(3);
		expect(await ledger.get(OTHER_ORG, BACKUP)).toBeNull();
		const kept = (await ledger.get(ORG, BACKUP))!;
		expect((await ledger.record({ ...kept, id: 'bkp_again', bytes: 1 })).id).toBe(BACKUP);
		expect(await ledger.get(ORG, 'bkp_again')).toBeNull();
	});
});

describe('POST /orgs/:orgId/sites/:siteId/backups', () => {
	it('records a planned operation for the site and starts the engine once per key', async () => {
		asMember();
		const { started } = services();
		const headers = { ...asUser, ...key() };
		const first = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: base(ORG, SITE),
			headers,
			json: { label: 'before the upgrade' }
		});
		expect(first.status).toBe(202);
		expect(first.json).toMatchObject({
			type: 'backup.create',
			status: 'planned',
			targetIds: [SITE]
		});
		const second = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: base(ORG, SITE),
			headers,
			json: { label: 'before the upgrade' }
		});
		expect(second.status).toBe(202);
		expect((second.json as { id: string }).id).toBe((first.json as { id: string }).id);
		expect(started.map((request) => request.workflow)).toEqual(['backup-create']);
		expect(started[0]!.params).toMatchObject({
			orgId: ORG,
			siteId: SITE,
			accountId: ACCOUNT,
			label: 'before the upgrade',
			restoreCeilingBytes: CEILING
		});
		expect(JSON.stringify(started)).not.toContain('secrets');
		const row = await db()
			.prepare('SELECT site_id, account_id, type FROM operations WHERE id = ?')
			.bind(started[0]!.id)
			.first();
		expect(row).toEqual({ site_id: SITE, account_id: ACCOUNT, type: 'backup.create' });
	});

	it('answers 404 for a site of another organisation and starts nothing', async () => {
		asMember();
		const { started } = services();
		const reply = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: base(ORG, FOREIGN),
			headers: { ...asUser, ...key() },
			json: {}
		});
		expect(reply.status).toBe(404);
		expect(started).toEqual([]);
	});

	it('needs an Idempotency-Key and marks the operation failed when the start is refused', async () => {
		asMember();
		services();
		const missing = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: base(ORG, SITE),
			headers: asUser,
			json: {}
		});
		expect(missing.status).toBe(400);
		services({ refuse: true });
		const refused = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: base(ORG, SITE),
			headers: { ...asUser, ...key() },
			json: {}
		});
		expect(refused.status).toBe(422);
		const operationId = (refused.json as { details: { operationId: string } }).details
			.operationId;
		const row = await db()
			.prepare('SELECT status FROM operations WHERE id = ?')
			.bind(operationId)
			.first();
		expect(row).toEqual({ status: 'failed' });
	});

	it('answers 501 until boot installs the backup services', async () => {
		asMember();
		const reply = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: base(ORG, SITE),
			headers: { ...asUser, ...key() },
			json: {}
		});
		expect(reply.status).toBe(501);
	});
});

describe('GET /orgs/:orgId/sites/:siteId/backups', () => {
	it('lists the site backups newest first and says why one cannot be restored', async () => {
		asMember();
		services();
		const reply = await send(backupsList, ROUTE, { path: base(ORG, SITE), headers: asUser });
		expect(reply.status).toBe(200);
		const items = (reply.json as { items: Record<string, unknown>[] }).items;
		expect(items.map((item) => item.id)).toEqual([BIG, BACKUP]);
		expect(items[0]).toMatchObject({ restorable: false, verified: false });
		expect(items[0]!.notRestorableReason).toContain('You can still export it');
		expect(items[1]).toMatchObject({
			restorable: true,
			notRestorableReason: null,
			verified: false
		});
	});

	it('pages with a cursor and hides another organisation', async () => {
		asMember();
		services();
		const first = await send(backupsList, ROUTE, {
			path: `${base(ORG, SITE)}?limit=1`,
			headers: asUser
		});
		const page = first.json as { items: { id: string }[]; nextCursor: string };
		expect(page.items.map((item) => item.id)).toEqual([BIG]);
		const second = await send(backupsList, ROUTE, {
			path: `${base(ORG, SITE)}?limit=1&cursor=${page.nextCursor}`,
			headers: asUser
		});
		expect((second.json as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
			BACKUP
		]);
		const foreign = await send(backupsList, ROUTE, {
			path: base(ORG, FOREIGN),
			headers: asUser
		});
		expect(foreign.status).toBe(404);
	});
});

describe('POST .../backups/:backupId/restore', () => {
	const route = `${ROUTE}/:backupId/restore`;
	const at = (backupId: string, siteId = SITE) => `${base(ORG, siteId)}/${backupId}/restore`;
	const post = (backupId: string, targetSiteId: string, siteId = SITE) =>
		send(backupRestore, route, {
			method: 'POST',
			path: at(backupId, siteId),
			headers: { ...asUser, ...key() },
			json: { targetSiteId }
		});

	it('starts a restore into another site of the organisation with the bounded waits', async () => {
		asMember();
		const { started } = services();
		const reply = await post(BACKUP, TARGET);
		expect(reply.status).toBe(202);
		expect(reply.json).toMatchObject({ type: 'backup.restore', targetIds: [TARGET] });
		expect(started[0]).toMatchObject({ workflow: 'backup-restore' });
		expect(started[0]!.params).toMatchObject({
			orgId: ORG,
			backupId: BACKUP,
			siteId: TARGET,
			accountId: ACCOUNT,
			waitMs: 90_000,
			pollMs: 2_000
		});
	});

	it('answers 404 for a target in another organisation, an unknown backup and another site backup', async () => {
		asMember();
		const { started } = services();
		expect((await post(BACKUP, FOREIGN)).status).toBe(404);
		expect((await post(`bkp_${'9'.repeat(20)}`, TARGET)).status).toBe(404);
		expect((await post(THEIRS, TARGET)).status).toBe(404);
		expect((await post(BACKUP, TARGET, FOREIGN)).status).toBe(404);
		expect(started).toEqual([]);
	});

	it('refuses a backup above the ceiling with the reason and starts nothing', async () => {
		asMember();
		const { started } = services();
		const reply = await post(BIG, TARGET);
		expect(reply.status).toBe(422);
		expect(reply.json).toMatchObject({ details: { reason: 'not_restorable', limit: CEILING } });
		expect(started).toEqual([]);
	});
});

describe('GET .../backups/:backupId/export', () => {
	const route = `${ROUTE}/:backupId/export`;
	const at = (backupId: string, siteId = SITE) => `${base(ORG, siteId)}/${backupId}/export`;

	it('streams the parts joined with a download header, after an audit row', async () => {
		asMember();
		const { audits } = services();
		const reply = await send(backupExport, route, { path: at(BACKUP), headers: asUser });
		expect(reply.status).toBe(200);
		expect(reply.text).toBe(DUMP.join(''));
		expect(reply.headers.get('content-disposition')).toBe(
			`attachment; filename="${BACKUP}.sql"`
		);
		expect(reply.headers.get('cache-control')).toBe('no-store');
		expect(reply.headers.get('content-type')).toContain('application/sql');
		expect(audits).toEqual([
			{
				actor: 'user:user-1',
				action: 'site.backup.export',
				target: SITE,
				detail: { backupId: BACKUP, bytes: DUMP.join('').length }
			}
		]);
	});

	it('refuses an API key even when the key holds the scope', async () => {
		const { denials } = asMember();
		const { audits } = services();
		const reply = await send(backupExport, route, { path: at(BACKUP), headers: asKey });
		expect(reply.status).toBe(403);
		expect(denials.map((denial) => denial.reason)).toEqual(['session_only']);
		expect(reply.text).not.toContain('INSERT');
		expect(audits).toEqual([]);
	});

	it('answers 404 for a backup of another organisation', async () => {
		asMember();
		const { audits } = services();
		expect(
			(await send(backupExport, route, { path: at(THEIRS, FOREIGN), headers: asUser })).status
		).toBe(404);
		expect(
			(await send(backupExport, route, { path: at(THEIRS), headers: asUser })).status
		).toBe(404);
		expect(audits).toEqual([]);
	});

	it('ends the download with an error when a stored part no longer matches', async () => {
		asMember();
		services();
		await bucket().put(backupKeys.part(ORG, SITE, BACKUP, 1), 'tampered');
		await expect(
			send(backupExport, route, { path: at(BACKUP), headers: asUser })
		).rejects.toThrow();
	});
});
