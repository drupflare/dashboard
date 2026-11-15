import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import restorePoints from '../../../../src/server/api/v1/orgs/[orgId]/sites/[id]/restore-points/index.get';
import { resetBackupServices, setBackupServices } from '../../../../src/server/services/backups';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { ORG } from '../../domain/fixtures';
import { SITES, asUser, send, setup } from '../fixtures/harness';
import { addBackup, addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const SITE = `site_${'b'.repeat(20)}`;
const ROUTE = '/api/v1/orgs/:orgId/sites/:id/restore-points';
const BASE = `/api/v1/orgs/${ORG}/sites/${SITE}/restore-points`;

let fixture: ReturnType<typeof sqliteClient>;

beforeEach(() => {
	fixture = sqliteClient();
	SITES[SITE] = ORG;
	addReadySite(fixture.raw, ORG, SITE);
	setBackupServices({ getDb: async () => fixture.client });
});

afterEach(() => {
	delete SITES[SITE];
	resetBackupServices();
	resetApiDeps();
});

describe('GET restore points', () => {
	it('lets a viewer read the saved copies and the point-in-time layer', async () => {
		setup({ role: 'viewer' });
		addBackup(fixture.raw, {
			id: 'bkp-1',
			organizationId: ORG,
			siteId: SITE,
			createdAt: 1_000
		});
		addBackup(fixture.raw, {
			id: 'bkp-2',
			organizationId: ORG,
			siteId: SITE,
			createdAt: 2_000,
			verified: 1
		});

		const reply = await send(restorePoints, ROUTE, { path: BASE, headers: asUser });

		expect(reply.status).toBe(200);
		const body = reply.json as {
			items: { id: string; layer: string; verified: boolean; moves: string[] }[];
			nextCursor: string | null;
			layers: { layer: string; windowDays: number }[];
		};
		expect(body.items.map((item) => item.id)).toEqual(['bkp-2', 'bkp-1']);
		expect(body.items.map((item) => item.layer)).toEqual(['export', 'export']);
		expect(body.items[0]?.verified).toBe(true);
		expect(body.items[1]?.verified).toBe(false);
		expect(body.items[0]?.moves.length).toBeGreaterThan(0);
		expect(body.nextCursor).toBeNull();
		expect(body.layers).toEqual([expect.objectContaining({ layer: 'pitr', windowDays: 30 })]);
	});

	it('answers not found for a site the caller cannot see', async () => {
		setup({ role: 'viewer' });
		const reply = await send(restorePoints, ROUTE, {
			path: `/api/v1/orgs/${ORG}/sites/site_${'c'.repeat(20)}/restore-points`,
			headers: asUser
		});
		expect(reply.status).toBe(404);
	});

	it('refuses a request with no session', async () => {
		setup({ role: 'viewer' });
		const reply = await send(restorePoints, ROUTE, { path: BASE });
		expect(reply.status).toBe(401);
	});
});
