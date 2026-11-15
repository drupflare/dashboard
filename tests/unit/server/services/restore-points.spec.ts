import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupServices, resetBackupServices } from '../../../../src/server/services/backups';
import { listRestorePoints } from '../../../../src/server/services/restore-points';
import { PITR_WINDOW_DAYS, RESTORE_LAYER_FACTS } from '../../../../src/shared/restore-points';
import { addBackup, addReadySite, sqliteClient } from '../fixtures/sqlite-client';

const ORG = 'org-1';
const SITE = 'site-1';

let fixture: ReturnType<typeof sqliteClient>;

function services() {
	return { ...backupServices(), getDb: async () => fixture.client };
}

beforeEach(() => {
	fixture = sqliteClient();
	addReadySite(fixture.raw, ORG, SITE);
});

afterEach(() => {
	resetBackupServices();
});

describe('listRestorePoints', () => {
	it('lists saved copies newest first, each with what it restores and what it does not', async () => {
		addBackup(fixture.raw, {
			id: 'bkp-old',
			organizationId: ORG,
			siteId: SITE,
			createdAt: 1_000
		});
		addBackup(fixture.raw, {
			id: 'bkp-new',
			organizationId: ORG,
			siteId: SITE,
			createdAt: 2_000,
			verified: 1,
			label: 'before upgrade'
		});

		const page = await listRestorePoints(services(), { orgId: ORG, siteId: SITE, limit: 10 });

		expect(page.nextCursor).toBeNull();
		expect(page.items.map((point) => point.id)).toEqual(['bkp-new', 'bkp-old']);
		expect(page.items[0]).toEqual({
			id: 'bkp-new',
			layer: 'export',
			createdAt: new Date(2_000).toISOString(),
			label: 'before upgrade',
			verified: true,
			moves: RESTORE_LAYER_FACTS.export.moves,
			doesNotMove: RESTORE_LAYER_FACTS.export.doesNotMove
		});
		expect(page.items[1]?.verified).toBe(false);
		expect(page.items[1]?.label).toBeNull();
	});

	it('offers point-in-time recovery once as a layer, with no rows of its own', async () => {
		const page = await listRestorePoints(services(), { orgId: ORG, siteId: SITE, limit: 10 });

		expect(page.items).toEqual([]);
		expect(page.layers).toEqual([
			{
				layer: 'pitr',
				windowDays: PITR_WINDOW_DAYS,
				moves: RESTORE_LAYER_FACTS.pitr.moves,
				doesNotMove: RESTORE_LAYER_FACTS.pitr.doesNotMove
			}
		]);
	});

	it('pages with a cursor and returns the next page after it', async () => {
		for (let index = 1; index <= 3; index++) {
			addBackup(fixture.raw, {
				id: `bkp-${index}`,
				organizationId: ORG,
				siteId: SITE,
				createdAt: index * 1_000
			});
		}

		const first = await listRestorePoints(services(), { orgId: ORG, siteId: SITE, limit: 2 });
		expect(first.items.map((point) => point.id)).toEqual(['bkp-3', 'bkp-2']);
		expect(first.nextCursor).not.toBeNull();

		const second = await listRestorePoints(services(), {
			orgId: ORG,
			siteId: SITE,
			limit: 2,
			cursor: first.nextCursor ?? undefined
		});
		expect(second.items.map((point) => point.id)).toEqual(['bkp-1']);
		expect(second.nextCursor).toBeNull();
	});

	it('refuses a site that is not ready in the organisation', async () => {
		await expect(
			listRestorePoints(services(), { orgId: ORG, siteId: 'site-missing', limit: 10 })
		).rejects.toMatchObject({ code: 'not_found' });
	});

	it('refuses a cursor it cannot decode', async () => {
		await expect(
			listRestorePoints(services(), { orgId: ORG, siteId: SITE, limit: 10, cursor: '!!' })
		).rejects.toMatchObject({ code: 'validation' });
	});
});
