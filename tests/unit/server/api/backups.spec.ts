import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import backupExport from '../../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/[backupId]/export.get';
import backupRestore from '../../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/[backupId]/restore.post';
import backupsList from '../../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/index.get';
import backupsCreate from '../../../../src/server/api/v1/orgs/[orgId]/sites/[siteId]/backups/index.post';
import { resetBackupServices } from '../../../../src/server/services/backups';
import { defineApi, resetApiDeps } from '../../../../src/server/utils/define-api';
import { ACTION_DEFS, isSessionOnly } from '../../../../src/shared/permissions';
import { ORG, facts, fresh, member } from '../../domain/fixtures';
import { asKey, asUser, send, setup } from '../fixtures/harness';

const SITE = `site_${'a'.repeat(20)}`;
const BACKUP = `bkp_${'1'.repeat(20)}`;
const BASE = `/api/v1/orgs/${ORG}/sites/${SITE}/backups`;
const ROUTE = '/api/v1/orgs/:orgId/sites/:siteId/backups';
const idem = { 'idempotency-key': 'key-backups-1' };

afterEach(() => {
	resetBackupServices();
	resetApiDeps();
});

describe('who may use the backup routes', () => {
	it('marks the export session only, and the restore against the destructive budget', () => {
		expect(isSessionOnly('site.backup.export')).toBe(true);
		expect(isSessionOnly('site.backup')).toBe(false);
		expect(ACTION_DEFS['site.restore'].budget).toBe('destructive-sites');
	});

	it('refuses a viewer on every route before any store is touched', async () => {
		setup({ role: 'viewer' });
		const replies = await Promise.all([
			send(backupsList, ROUTE, { path: BASE, headers: asUser }),
			send(backupsCreate, ROUTE, {
				method: 'POST',
				path: BASE,
				headers: { ...asUser, ...idem },
				json: {}
			}),
			send(backupRestore, `${ROUTE}/:backupId/restore`, {
				method: 'POST',
				path: `${BASE}/${BACKUP}/restore`,
				headers: { ...asUser, ...idem },
				json: { targetSiteId: SITE }
			}),
			send(backupExport, `${ROUTE}/:backupId/export`, {
				path: `${BASE}/${BACKUP}/export`,
				headers: asUser
			})
		]);
		expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403, 403]);
	});

	it('lets a developer back up and refuses the same developer a restore or an export', async () => {
		setup({ role: 'developer' });
		const create = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: BASE,
			headers: { ...asUser, ...idem },
			json: {}
		});
		expect(create.status).toBe(501);
		const restore = await send(backupRestore, `${ROUTE}/:backupId/restore`, {
			method: 'POST',
			path: `${BASE}/${BACKUP}/restore`,
			headers: { ...asUser, ...idem },
			json: { targetSiteId: SITE }
		});
		expect(restore.status).toBe(403);
		const download = await send(backupExport, `${ROUTE}/:backupId/export`, {
			path: `${BASE}/${BACKUP}/export`,
			headers: asUser
		});
		expect(download.status).toBe(403);
	});

	it('answers 501 for an admin until boot installs the backup services', async () => {
		setup({ role: 'admin' });
		const route = `${ROUTE}/:backupId/restore`;
		const restore = await send(backupRestore, route, {
			method: 'POST',
			path: `${BASE}/${BACKUP}/restore`,
			headers: { ...asUser, ...idem },
			json: { targetSiteId: SITE }
		});
		expect(restore.status).toBe(501);
		const download = await send(backupExport, `${ROUTE}/:backupId/export`, {
			path: `${BASE}/${BACKUP}/export`,
			headers: asUser
		});
		expect(download.status).toBe(501);
	});

	it('refuses a key on the export, whatever its scopes', async () => {
		const { denials } = setup({
			facts: () => ({
				...facts({ ...member('owner'), ...fresh }),
				key: { id: 'key-1', scopes: ['site.backup.export'] }
			})
		});
		const reply = await send(backupExport, `${ROUTE}/:backupId/export`, {
			path: `${BASE}/${BACKUP}/export`,
			headers: asKey
		});
		expect(reply.status).toBe(403);
		expect(denials.map((denial) => denial.reason)).toEqual(['session_only']);
	});

	it('rejects a malformed id and a body with extra fields', async () => {
		setup({ role: 'admin' });
		const badId = await send(backupRestore, `${ROUTE}/:backupId/restore`, {
			method: 'POST',
			path: `${BASE}/not-a-backup/restore`,
			headers: { ...asUser, ...idem },
			json: { targetSiteId: SITE }
		});
		expect(badId.status).toBe(400);
		const extra = await send(backupsCreate, ROUTE, {
			method: 'POST',
			path: BASE,
			headers: { ...asUser, ...idem },
			json: { label: 'x', secrets: true }
		});
		expect(extra.status).toBe(400);
	});
});

describe('a raw response from defineApi', () => {
	const download = defineApi(
		{
			scope: 'organization',
			action: 'site.backup',
			rateClass: 'read',
			tags: ['sites'],
			summary: 'raw',
			params: z.object({ orgId: z.string() }),
			body: z.strictObject({})
		},
		async () => new Response('raw bytes', { headers: { 'x-raw': '1' } })
	);

	it('goes out as it is, and cannot be stored for an idempotent replay', async () => {
		setup({ role: 'admin' });
		const plain = await send(download, '/raw/:orgId', {
			method: 'POST',
			path: `/raw/${ORG}`,
			headers: asUser,
			json: {}
		});
		expect(plain.status).toBe(200);
		expect(plain.text).toBe('raw bytes');
		expect(plain.headers.get('x-raw')).toBe('1');
		const keyed = await send(download, '/raw/:orgId', {
			method: 'POST',
			path: `/raw/${ORG}`,
			headers: { ...asUser, ...idem },
			json: {}
		});
		expect(keyed.status).toBe(500);
		expect(keyed.text).not.toContain('raw bytes');
	});
});
