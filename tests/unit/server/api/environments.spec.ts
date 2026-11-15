import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import verify from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/backups/[backupId]/verify.post';
import environmentDelete from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/environments/[envId].delete';
import environments from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/environments/index.get';
import environmentCreate from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/environments/index.post';
import pitr from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/restore-points/pitr.post';
import { createEnvironment } from '../../../../src/server/db/repos/environments';
import { resetSiteServices, setSiteServices } from '../../../../src/server/services/sites';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ORG } from '../../domain/fixtures';
import { SITES, asUser, send, setup } from '../fixtures/harness';
import { addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const SITE = `site_${'d'.repeat(20)}`;
const ROUTE = '/api/v1/orgs/:orgId/sites/:id/environments';
const BASE = `/api/v1/orgs/${ORG}/sites/${SITE}/environments`;

let fixture: ReturnType<typeof sqliteClient>;

beforeEach(() => {
	fixture = sqliteClient();
	SITES[SITE] = ORG;
	addReadySite(fixture.raw, ORG, SITE);
	setSiteServices({ getDb: async () => fixture.client });
});

afterEach(() => {
	delete SITES[SITE];
	resetSiteServices();
	resetApiDeps();
});

describe('GET environments', () => {
	it('answers an empty list for a site with no environments', async () => {
		setup({ role: 'viewer' });
		const reply = await send(environments, ROUTE, { path: BASE, headers: asUser });
		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({ items: [] });
	});

	it('returns the rows the site holds and leaves out deleted ones', async () => {
		setup({ role: 'viewer' });
		const row = {
			organizationId: ORG,
			siteId: SITE,
			kind: 'dev' as const,
			name: 'quiet-river-dev',
			host: 'quiet-river-dev.drupflare.app',
			status: 'ready' as const,
			envSiteId: null,
			sourceBackupId: null,
			ttlAt: 7_000,
			createdAt: 1_000
		};
		await createEnvironment(fixture.client, { ...row, id: 'env-live' });
		await createEnvironment(fixture.client, {
			...row,
			id: 'env-gone',
			createdAt: 900,
			host: 'gone.drupflare.app'
		});
		fixture.raw
			.prepare('UPDATE site_environments SET deleted_at = 2 WHERE id = ?')
			.run('env-gone');

		const reply = await send(environments, ROUTE, { path: BASE, headers: asUser });

		expect(reply.status).toBe(200);
		expect(reply.json).toEqual({
			items: [
				{
					id: 'env-live',
					kind: 'dev',
					name: 'quiet-river-dev',
					host: 'quiet-river-dev.drupflare.app',
					status: 'ready',
					sourceBackupId: null,
					ttlAt: 7_000,
					createdAt: 1_000
				}
			]
		});
	});

	it('answers not found for a site the caller cannot see', async () => {
		setup({ role: 'viewer' });
		const reply = await send(environments, ROUTE, {
			path: `/api/v1/orgs/${ORG}/sites/site_${'e'.repeat(20)}/environments`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});
});

describe('who may change environments, verify a backup or restore to a moment', () => {
	const idem = { 'idempotency-key': 'key-env-1' };
	const BACKUP = `bkp_${'1'.repeat(20)}`;
	const ENV = `env_${'2'.repeat(20)}`;
	const site = `/api/v1/orgs/${ORG}/sites/${SITE}`;

	it('refuses a viewer on every route before any store is touched', async () => {
		setup({ role: 'viewer' });
		const replies = await Promise.all([
			send(environmentCreate, ROUTE, {
				method: 'POST',
				path: BASE,
				headers: { ...asUser, ...idem },
				json: { kind: 'staging' }
			}),
			send(environmentDelete, `${ROUTE}/:envId`, {
				method: 'DELETE',
				path: `${BASE}/${ENV}`,
				headers: { ...asUser, ...idem }
			}),
			send(verify, '/api/v1/orgs/:orgId/sites/:id/backups/:backupId/verify', {
				method: 'POST',
				path: `${site}/backups/${BACKUP}/verify`,
				headers: { ...asUser, ...idem }
			}),
			send(pitr, '/api/v1/orgs/:orgId/sites/:id/restore-points/pitr', {
				method: 'POST',
				path: `${site}/restore-points/pitr`,
				headers: { ...asUser, ...idem },
				json: { at: 1_700_000_000_000 }
			})
		]);
		expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403, 403]);
	});

	it('rejects a preview kind, extra fields and a malformed environment id', async () => {
		setup({ role: 'admin' });
		const preview = await send(environmentCreate, ROUTE, {
			method: 'POST',
			path: BASE,
			headers: { ...asUser, ...idem },
			json: { kind: 'preview' }
		});
		expect(preview.status).toBe(400);
		const extra = await send(environmentCreate, ROUTE, {
			method: 'POST',
			path: BASE,
			headers: { ...asUser, ...idem },
			json: { kind: 'dev', ttl: 5 }
		});
		expect(extra.status).toBe(400);
		const badId = await send(environmentDelete, `${ROUTE}/:envId`, {
			method: 'DELETE',
			path: `${BASE}/not-an-environment`,
			headers: { ...asUser, ...idem }
		});
		expect(badId.status).toBe(400);
	});
});
