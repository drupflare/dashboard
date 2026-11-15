import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1OperationStore } from '../../../engine/src/operations/store';
import { applySchema, createCollegeDB, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { withAtomicBatch } from '../../../src/server/db/repos/atomic-shards';
import {
	getRelease,
	getReleaseByVersion,
	latestReleases,
	listReleases,
	registerRelease,
	type NewRelease
} from '../../../src/server/db/repos/releases';
import { getSite } from '../../../src/server/db/repos/sites';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: Awaited<ReturnType<typeof ensureCollegeDB>>;

beforeAll(async () => {
	harness = await openBindings();
	env = harness.env;
	await applySchema(createCollegeDB(env));
	db = await ensureCollegeDB(withAtomicBatch(env));
});

afterAll(() => harness.close());

const ORG = 'org_relbind0001';
const NOW = 1_790_000_000_000;
const digest = (n: number) => `sha256:${String(n).padStart(64, '0')}`;

const release = (over: Partial<NewRelease> & Pick<NewRelease, 'id' | 'version'>): NewRelease => ({
	kind: 'worker',
	manifestDigest: digest(1),
	schemaVersion: 1,
	acceptsSchema: 1,
	publishedAt: NOW,
	now: NOW,
	...over
});

describe('the releases table', () => {
	it('registers a release and reads it back by id and by version', async () => {
		const input = release({ id: 'rel-a1', version: '1.0.0', advisoryAt: NOW + 5 });
		const { release: stored, created } = await registerRelease(db, input);
		expect(created).toBe(true);
		expect(stored).toEqual({
			id: 'rel-a1',
			kind: 'worker',
			version: '1.0.0',
			manifestDigest: digest(1),
			schemaVersion: 1,
			acceptsSchema: 1,
			publishedAt: NOW,
			advisoryAt: NOW + 5,
			createdAt: NOW
		});
		expect(await getRelease(db, 'rel-a1')).toEqual(stored);
		expect(await getReleaseByVersion(db, 'worker', '1.0.0')).toEqual(stored);
		expect(await getRelease(db, 'rel-missing')).toBeNull();
		expect(await getReleaseByVersion(db, 'php', '1.0.0')).toBeNull();
	});

	it('is idempotent on kind and version and changes nothing on a repeat', async () => {
		await registerRelease(db, release({ id: 'rel-b1', version: '2.0.0', kind: 'php' }));
		const again = await registerRelease(
			db,
			release({ id: 'rel-b2', version: '2.0.0', kind: 'php', schemaVersion: 9, now: NOW + 1 })
		);
		expect(again.created).toBe(false);
		expect(again.release).toMatchObject({ id: 'rel-b1', schemaVersion: 1, createdAt: NOW });
		expect(await getRelease(db, 'rel-b2')).toBeNull();
	});

	it('lets the same version exist in two kinds', async () => {
		const a = await registerRelease(db, release({ id: 'rel-c1', version: '3.0.0' }));
		const b = await registerRelease(
			db,
			release({ id: 'rel-c2', version: '3.0.0', kind: 'drupal-pack' })
		);
		expect([a.created, b.created]).toEqual([true, true]);
	});

	it('lists a kind newest first and gives the latest per kind', async () => {
		for (const [id, at] of [
			['rel-d1', 10],
			['rel-d2', 30],
			['rel-d3', 20]
		] as const) {
			await registerRelease(
				db,
				release({ id, version: `9.${at}.0`, kind: 'drupal-pack', publishedAt: NOW + at })
			);
		}
		const list = await listReleases(db, 'drupal-pack', 3);
		expect(list.map((r) => r.id)).toEqual(['rel-d2', 'rel-d3', 'rel-d1']);
		expect((await listReleases(db, 'drupal-pack', 1)).map((r) => r.id)).toEqual(['rel-d2']);
		const latest = await latestReleases(db);
		expect(latest['drupal-pack']?.id).toBe('rel-d2');
		expect(latest.php?.id).toBe('rel-b1');
		expect(latest.worker).toBeDefined();
	});

	it('refuses a kind outside the contract and a negative schema version', async () => {
		await expect(
			registerRelease(db, release({ id: 'rel-e1', version: '1', kind: 'other' as 'worker' }))
		).rejects.toThrow();
		await expect(
			registerRelease(db, release({ id: 'rel-e2', version: '2', schemaVersion: -1 }))
		).rejects.toThrow();
	});
});

describe('the data schema version on a site', () => {
	const site = (n: number, release: string | null = null) => ({
		id: `site_relbind${String(n).padStart(4, '0')}`,
		organizationId: ORG,
		name: `Site ${n}`,
		plane: 'managed',
		accountId: 'a'.repeat(32),
		category: 'cms' as const,
		config: 'managed' as const,
		releaseId: release
	});

	it('starts null for a site whose release is not registered', async () => {
		const store = new D1OperationStore(env.DB);
		await store.activateSite(site(1, 'rel-unknown'), NOW);
		expect((await getSite(db, ORG, site(1).id))?.dataSchemaVersion).toBeNull();
	});

	it('takes the schema of the release a site is created on', async () => {
		await registerRelease(db, release({ id: 'rel-s2', version: '5.0.0', schemaVersion: 2 }));
		const store = new D1OperationStore(env.DB);
		await store.activateSite(site(2, 'rel-s2'), NOW);
		expect((await getSite(db, ORG, site(2).id))?.dataSchemaVersion).toBe(2);
	});

	it('raises on an upgrade and never goes down on a rollback to older code', async () => {
		await registerRelease(
			db,
			release({ id: 'rel-old', version: '6.0.0', schemaVersion: 1, acceptsSchema: 1 })
		);
		await registerRelease(
			db,
			release({ id: 'rel-new', version: '6.1.0', schemaVersion: 4, acceptsSchema: 1 })
		);
		const store = new D1OperationStore(env.DB);
		await store.activateSite(site(3, 'rel-old'), NOW);
		const read = async () => (await getSite(db, ORG, site(3).id))?.dataSchemaVersion;
		expect(await read()).toBe(1);
		await store.setSiteRelease(site(3).id, 'rel-new', NOW + 1);
		expect(await read()).toBe(4);
		await store.setSiteRelease(site(3).id, 'rel-old', NOW + 2);
		expect(await read()).toBe(4);
		expect((await getSite(db, ORG, site(3).id))?.releaseId).toBe('rel-old');
	});

	it('leaves the version as it was when the release is not registered', async () => {
		const store = new D1OperationStore(env.DB);
		await store.activateSite(site(4, 'rel-s2'), NOW);
		await store.setSiteRelease(site(4).id, 'rel-nowhere', NOW + 1);
		expect((await getSite(db, ORG, site(4).id))?.dataSchemaVersion).toBe(2);
	});

	it('keeps the version when a repeat activation names no release', async () => {
		const store = new D1OperationStore(env.DB);
		await store.activateSite(site(5, 'rel-s2'), NOW);
		await store.activateSite(site(5, null), NOW + 1);
		expect((await getSite(db, ORG, site(5).id))?.dataSchemaVersion).toBe(2);
	});
});
