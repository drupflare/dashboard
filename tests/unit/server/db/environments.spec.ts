import { describe, expect, it } from 'vitest';
import {
	createEnvironment,
	EnvironmentStatusError,
	getEnvironment,
	listEnvironments,
	markEnvironmentDeleted,
	setEnvironmentStatus,
	type EnvironmentRecord
} from '../../../../src/server/db/repos/environments';
import { sqliteClient } from '../fixtures/sqlite-client';

const ORG = 'org-1';
const SITE = 'site-1';

function environment(
	overrides: Partial<EnvironmentRecord> = {}
): Omit<EnvironmentRecord, 'deletedAt'> {
	return {
		id: 'env-1',
		organizationId: ORG,
		siteId: SITE,
		kind: 'staging',
		name: 'quiet-river-staging',
		host: 'quiet-river-staging.drupflare.app',
		status: 'creating',
		envSiteId: null,
		sourceBackupId: 'bkp-1',
		ttlAt: null,
		createdAt: 1_000,
		...overrides
	};
}

describe('site environment rows', () => {
	it('round-trips every column, including the nullable ones', async () => {
		const { client } = sqliteClient();
		await createEnvironment(client, environment({ ttlAt: 5_000 }));
		await createEnvironment(
			client,
			environment({
				id: 'env-2',
				sourceBackupId: null,
				ttlAt: null,
				host: 'two.drupflare.app'
			})
		);

		expect(await getEnvironment(client, ORG, SITE, 'env-1')).toEqual({
			...environment({ ttlAt: 5_000 }),
			deletedAt: null
		});
		expect(await getEnvironment(client, ORG, SITE, 'env-2')).toEqual({
			...environment({
				id: 'env-2',
				sourceBackupId: null,
				ttlAt: null,
				host: 'two.drupflare.app'
			}),
			deletedAt: null
		});
	});

	it('lists a site newest first and never another organisation or site', async () => {
		const { client } = sqliteClient();
		await createEnvironment(
			client,
			environment({ id: 'env-old', createdAt: 1_000, host: 'old.drupflare.app' })
		);
		await createEnvironment(
			client,
			environment({ id: 'env-new', createdAt: 2_000, host: 'new.drupflare.app' })
		);
		await createEnvironment(
			client,
			environment({
				id: 'env-other-site',
				siteId: 'site-2',
				host: 'other-site.drupflare.app'
			})
		);
		await createEnvironment(
			client,
			environment({
				id: 'env-other-org',
				organizationId: 'org-2',
				host: 'other-org.drupflare.app'
			})
		);

		const rows = await listEnvironments(client, ORG, SITE);
		expect(rows.map((row) => row.id)).toEqual(['env-new', 'env-old']);
	});

	it('marks a row deleted once, then hides it from reads', async () => {
		const { client } = sqliteClient();
		await createEnvironment(client, environment());

		expect(await markEnvironmentDeleted(client, ORG, SITE, 'env-1', 9_000)).toBe(true);
		expect(await markEnvironmentDeleted(client, ORG, SITE, 'env-1', 9_500)).toBe(false);
		expect(await getEnvironment(client, ORG, SITE, 'env-1')).toBeNull();
		expect(await listEnvironments(client, ORG, SITE)).toEqual([]);
	});

	it('refuses a kind outside staging, dev and preview', async () => {
		const { client } = sqliteClient();
		await expect(
			createEnvironment(client, environment({ kind: 'prod' as 'staging' }))
		).rejects.toThrow(/CHECK/);
	});

	it('refuses a status outside the vocabulary', async () => {
		const { client } = sqliteClient();
		await expect(
			createEnvironment(client, environment({ status: 'pending' as 'creating' }))
		).rejects.toBeInstanceOf(EnvironmentStatusError);
		await createEnvironment(client, environment());
		await expect(
			setEnvironmentStatus(client, ORG, SITE, 'env-1', 'broken' as 'ready', 2_000)
		).rejects.toBeInstanceOf(EnvironmentStatusError);
	});

	it('moves along allowed edges only, and a repeat changes nothing', async () => {
		const { client } = sqliteClient();
		await createEnvironment(client, environment());

		await setEnvironmentStatus(client, ORG, SITE, 'env-1', 'ready', 2_000);
		await setEnvironmentStatus(client, ORG, SITE, 'env-1', 'ready', 3_000);
		expect((await getEnvironment(client, ORG, SITE, 'env-1'))?.status).toBe('ready');
		await expect(
			setEnvironmentStatus(client, ORG, SITE, 'env-1', 'creating', 4_000)
		).rejects.toBeInstanceOf(EnvironmentStatusError);
	});

	it('keeps one live environment per host', async () => {
		const { client } = sqliteClient();
		await createEnvironment(client, environment());
		await expect(createEnvironment(client, environment({ id: 'env-2' }))).rejects.toThrow(
			/UNIQUE/
		);
		await markEnvironmentDeleted(client, ORG, SITE, 'env-1', 9_000);
		await createEnvironment(client, environment({ id: 'env-3' }));
	});
});
