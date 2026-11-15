import { sha256Hex } from '@contracts/common';
import { describe, expect, it } from 'vitest';
import { scriptName } from '../../../contracts/src/sites';
import { customBundlesOf } from '../../../engine/src/adapters/custom-bundles';
import { releasesInBucket, releasesWithCustom } from '../../../engine/src/adapters/releases';
import { rollbackFactsOf } from '../../../engine/src/adapters/rollback';
import {
	buildCustomBundle,
	customKeys,
	customReleaseId,
	putCustomBundle,
	unpackArchive
} from '../../../engine/src/custom-bundle';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import type { Releases, RollbackDeps } from '../../../engine/src/ports';
import { PermanentError } from '../../../engine/src/step';
import { planSiteCreate, runSiteCreate } from '../../../engine/src/workflows/site-create';
import {
	planSiteRollback,
	runSiteRollback,
	type SiteRollbackInput
} from '../../../engine/src/workflows/site-rollback';
import {
	planSiteUpgrade,
	runSiteUpgrade,
	type SiteUpgradeInput
} from '../../../engine/src/workflows/site-upgrade';
import { recipeSchema } from '../../../src/shared/recipes';
import { goodFiles, tarGz, TODAY, type Files } from './custom-fixtures';
import { makeRunner, makeWorld, type World } from './fakes';

const MARKER = 'LEAK-MARKER-7f3a91';

// a bucket in memory with the two methods the release store and the purge call
function bucket() {
	const objects = new Map<string, Uint8Array>();
	return {
		objects,
		get: async (key: string) => {
			const bytes = objects.get(key);
			return bytes === undefined
				? null
				: ({
						json: async () => JSON.parse(new TextDecoder().decode(bytes)),
						arrayBuffer: async () =>
							bytes.buffer.slice(
								bytes.byteOffset,
								bytes.byteOffset + bytes.byteLength
							)
					} as never);
		},
		put: async (key: string, bytes: Uint8Array) => void objects.set(key, bytes),
		deletePrefix: async (prefix: string) => {
			let removed = 0;
			for (const key of [...objects.keys()]) {
				if (key.startsWith(prefix)) {
					objects.delete(key);
					removed++;
				}
			}
			return removed;
		}
	};
}

type Bucket = ReturnType<typeof bucket>;

const nothing: Releases = {
	manifest: async (id) => {
		throw new PermanentError('release_not_found', id);
	},
	part: async (key) => {
		throw new PermanentError('release_part_missing', key);
	}
};

// the intake: unpack, build, store the parts, register the row
async function publish(
	world: World,
	store: Bucket,
	files: Files,
	fileName = 'app.tar.gz',
	orgId = world.orgId
) {
	const archive = await tarGz(files);
	const sha256 = await sha256Hex(archive);
	const releaseId = await customReleaseId(orgId, sha256);
	const build = await buildCustomBundle({
		files: await unpackArchive(archive),
		archiveSha256: sha256,
		releaseId,
		today: TODAY
	});
	if (build.bundle === null)
		throw new Error(`not deployable: ${build.findings.map((f) => f.code)}`);
	await store.put(customKeys.archive(orgId, sha256), archive);
	await putCustomBundle(store, releaseId, build.bundle);
	world.sqlite
		.prepare(
			`INSERT INTO custom_releases (id, organization_id, sha256, file_name, bundle_key, recipe, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`
		)
		.run(
			releaseId,
			orgId,
			sha256,
			fileName,
			customKeys.archive(orgId, sha256),
			JSON.stringify(recipeSchema.parse(build.recipe)),
			world.clock.now()
		);
	return { releaseId, sha256, build, archive };
}

const withMarker = (extra: Record<string, unknown> = {}, file = 'v1') =>
	goodFiles(extra, {
		'dist/index.js': `export default { fetch() { return new Response("${MARKER} ${file}"); } };`,
		'dist/public/index.html': `<p>${MARKER} ${file}</p>`
	});

const DO_CONFIG = {
	durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Room' }] },
	migrations: [{ tag: 'v1', new_sqlite_classes: ['Room'] }]
};

async function customWorld(files: Files = withMarker()) {
	const world = await makeWorld();
	const store = bucket();
	const first = await publish(world, store, files);
	world.deps.releases = releasesWithCustom(nothing, releasesInBucket(store as never));
	const { input } = world;
	input.site.kind = 'custom';
	input.site.category = 'workers';
	input.releaseId = first.releaseId;
	delete input.firstRun;
	input.probe = { path: '/', expectStatus: 200 };
	input.customResources = first.build.bundle!.spec.resources;
	return { world, store, first };
}

async function begin(
	world: World,
	id: string,
	key: string,
	plan: ReturnType<typeof planSiteUpgrade>
) {
	await world.store.begin({
		operation: newOperation({
			id,
			orgId: world.orgId,
			idempotencyKey: key,
			frozen: await freezePlan(plan),
			now: world.clock.now()
		}),
		accountId: world.accountId,
		siteId: world.siteId
	});
}

async function create(world: World) {
	await begin(world, world.operationId, 'create-1', planSiteCreate(world.input));
	return runSiteCreate(makeRunner(new Map()).runner, world.deps, world.input);
}

function upgradeInput(world: World, to: string, from: string, id: string): SiteUpgradeInput {
	return {
		operationId: id,
		site: {
			id: world.siteId,
			orgId: world.orgId,
			kind: 'custom',
			plane: 'managed',
			config: 'managed',
			ring: 'R0',
			plan: 'managed-pro',
			accountId: world.accountId
		},
		hostname: world.input.hostname,
		releaseId: to,
		currentRelease: from,
		probe: { path: '/', expectStatus: 200 }
	};
}

const UP = `op_${'u'.repeat(26)}`;
const BACK = `op_${'b'.repeat(26)}`;

async function update(world: World, to: string, from: string, id = UP) {
	world.clock.advance(1_000);
	const input = upgradeInput(world, to, from, id);
	await begin(world, id, `key-${id}`, planSiteUpgrade(input));
	return runSiteUpgrade(makeRunner(new Map()).runner, world.deps, input);
}

async function rollBack(world: World, to: string, from: string) {
	world.clock.advance(1_000);
	const input: SiteRollbackInput = upgradeInput(world, to, from, BACK);
	await begin(world, BACK, 'key-back', planSiteRollback(input));
	const deps: RollbackDeps = { ...world.deps, rollbackFacts: rollbackFactsOf(world.db) };
	return runSiteRollback(makeRunner(new Map()).runner, deps, input);
}

const live = (world: World) => world.cf.scripts.get(scriptName(world.siteId))!;
const metadataOf = (world: World) =>
	JSON.parse(live(world).metadata) as {
		bindings: { type: string; name: string; [key: string]: unknown }[];
		compatibility_date: string;
		tags: string[];
		migrations?: { tag: string }[];
	};
const releaseRow = (world: World) =>
	(
		world.sqlite.prepare('SELECT release_id FROM sites WHERE id = ?').get(world.siteId) as {
			release_id: string | null;
		}
	).release_id;
const notes = (world: World) =>
	world.sqlite
		.prepare(
			'SELECT release_id, note FROM site_revisions WHERE site_id = ? ORDER BY created_at, id'
		)
		.all(world.siteId) as { release_id: string; note: string | null }[];

describe('creating a site from a bundle', () => {
	it('provisions the stores the bundle names and nothing of the Drupal set', async () => {
		const { world, first } = await customWorld();
		const { runner, executed } = makeRunner(new Map());
		await begin(world, world.operationId, 'create-1', planSiteCreate(world.input));
		expect(await runSiteCreate(runner, world.deps, world.input)).toEqual({
			status: 'succeeded'
		});
		expect(executed).toEqual([
			'start',
			'lease',
			'reserve-name',
			'resource.CACHE',
			'resource.UPLOADS',
			'assets.session',
			'assets.upload.0',
			'assets.complete',
			'upload-script',
			'authority',
			'route',
			'verify',
			'activate',
			'finalize',
			'release-lease'
		]);
		const rows = await world.ledger.live(world.siteId);
		expect(rows.map((row) => [row.kind, row.binding]).sort()).toEqual([
			['kv', 'CACHE'],
			['r2', 'UPLOADS'],
			['script', 'SCRIPT']
		]);
		expect(rows.find((row) => row.binding === 'CACHE')!.name).toBe(
			`s-${world.siteId.slice('site_'.length)}-cache`
		);
		expect(releaseRow(world)).toBe(first.releaseId);
	});

	it('uploads the script with the bundle own bindings, date, flags and the plan tags', async () => {
		const { world, first } = await customWorld(withMarker(DO_CONFIG));
		await create(world);
		const metadata = metadataOf(world);
		const named = Object.fromEntries(
			metadata.bindings.map((binding) => [binding.name, binding])
		);
		expect(Object.keys(named).sort()).toEqual(['CACHE', 'GREETING', 'ROOM', 'UPLOADS']);
		expect(named.GREETING).toMatchObject({ type: 'plain_text', text: 'hello' });
		expect(named.CACHE).toMatchObject({ type: 'kv_namespace' });
		expect(named.UPLOADS).toMatchObject({ type: 'r2_bucket' });
		expect(named.ROOM).toEqual({
			type: 'durable_object_namespace',
			name: 'ROOM',
			class_name: 'Room'
		});
		expect(named.ROOM).not.toHaveProperty('script_name');
		expect(metadata.compatibility_date).toBe('2026-08-01');
		expect(metadata.tags).toEqual(
			expect.arrayContaining([
				`o:${world.orgId}`,
				`s:${world.siteId}`,
				'k:custom',
				'p:managed',
				`v:${first.releaseId}`,
				'm:v1'
			])
		);
		expect(JSON.stringify(metadata)).not.toContain('"CMS"');
		expect(JSON.stringify(metadata)).not.toContain('SITE_ID');
		expect(live(world).modules).toEqual(['index.js']);
	});

	it('records the first deploy in the history with the file name and the hash prefix', async () => {
		const { world, first } = await customWorld();
		await create(world);
		expect(notes(world)).toEqual([
			{
				release_id: first.releaseId,
				note: `Uploaded app.tar.gz (${first.sha256.slice(0, 12)})`
			}
		]);
	});

	it('ignores a ledger row the bundle does not name', async () => {
		const { world } = await customWorld();
		await world.ledger.intend(
			{
				siteId: world.siteId,
				accountId: world.accountId,
				operationId: 'op_other',
				kind: 'r2',
				binding: 'STRATA_STORE',
				name: 'strata'
			},
			world.clock.now()
		);
		expect(await create(world)).toEqual({ status: 'succeeded' });
		expect(metadataOf(world).bindings.map((binding) => binding.name)).not.toContain(
			'STRATA_STORE'
		);
	});
});

describe('updating a custom site', () => {
	it('runs the new bundle and records both deploys', async () => {
		const { world, store, first } = await customWorld();
		await create(world);
		const second = await publish(world, store, withMarker({}, 'v2'), 'app-2.tar.gz');
		expect(await update(world, second.releaseId, first.releaseId)).toEqual({
			status: 'succeeded'
		});
		expect(live(world).tags).toContain(`v:${second.releaseId}`);
		expect(releaseRow(world)).toBe(second.releaseId);
		expect(notes(world).map((row) => row.note)).toEqual([
			`Uploaded app.tar.gz (${first.sha256.slice(0, 12)})`,
			`Uploaded app-2.tar.gz (${second.sha256.slice(0, 12)})`
		]);
	});

	it('adds a migration step and a class without refusing', async () => {
		const { world, store, first } = await customWorld(withMarker(DO_CONFIG));
		await create(world);
		const second = await publish(
			world,
			store,
			withMarker(
				{
					durable_objects: {
						bindings: [
							{ name: 'ROOM', class_name: 'Room' },
							{ name: 'LOBBY', class_name: 'Lobby' }
						]
					},
					migrations: [
						{ tag: 'v1', new_sqlite_classes: ['Room'] },
						{ tag: 'v2', new_sqlite_classes: ['Lobby'] }
					]
				},
				'v2'
			)
		);
		expect(await update(world, second.releaseId, first.releaseId)).toEqual({
			status: 'succeeded'
		});
		expect(metadataOf(world).tags).toContain('m:v2');
	});

	it('refuses a bundle that removes a class the site holds and leaves the site as it was', async () => {
		const { world, store, first } = await customWorld(withMarker(DO_CONFIG));
		await create(world);
		const second = await publish(
			world,
			store,
			withMarker({ migrations: DO_CONFIG.migrations }, 'v2')
		);
		const uploads = world.cf.uploads.length;
		const outcome = await update(world, second.releaseId, first.releaseId);
		expect(outcome).toMatchObject({ status: 'failed' });
		expect((outcome as { reason: string }).reason).toContain('removes the Room class');
		expect(world.cf.uploads.length).toBe(uploads);
		expect(live(world).tags).toContain(`v:${first.releaseId}`);
		expect(releaseRow(world)).toBe(first.releaseId);
	});

	it('refuses a bundle that renames a class', async () => {
		const { world, store, first } = await customWorld(withMarker(DO_CONFIG));
		await create(world);
		const second = await publish(
			world,
			store,
			withMarker(
				{
					durable_objects: { bindings: [{ name: 'ROOM', class_name: 'Chamber' }] },
					migrations: [
						{ tag: 'v1', new_sqlite_classes: ['Room'] },
						{ tag: 'v2', new_sqlite_classes: ['Chamber'] }
					]
				},
				'v2'
			)
		);
		const outcome = await update(world, second.releaseId, first.releaseId);
		expect((outcome as { reason: string }).reason).toContain('removes the Room class');
	});

	it('refuses a bundle whose migrations leave out the tag the site is at', async () => {
		const { world, store, first } = await customWorld(withMarker(DO_CONFIG));
		await create(world);
		const second = await publish(
			world,
			store,
			withMarker(
				{
					...DO_CONFIG,
					migrations: [{ tag: 'v9', new_sqlite_classes: ['Room'] }]
				},
				'v2'
			)
		);
		const outcome = await update(world, second.releaseId, first.releaseId);
		expect((outcome as { reason: string }).reason).toContain('migration_downgrade');
	});
});

describe('rolling back a custom site', () => {
	it('uploads the earlier bundle again and puts the release id back', async () => {
		const { world, store, first } = await customWorld();
		await create(world);
		const second = await publish(world, store, withMarker({}, 'v2'), 'app-2.tar.gz');
		await update(world, second.releaseId, first.releaseId);
		const uploads = world.cf.uploads.length;
		expect(await rollBack(world, first.releaseId, second.releaseId)).toEqual({
			status: 'succeeded'
		});
		expect(world.cf.uploads.length).toBe(uploads + 1);
		expect(live(world).tags).toContain(`v:${first.releaseId}`);
		expect(releaseRow(world)).toBe(first.releaseId);
		expect(notes(world).at(-1)!.note).toBe(
			`Uploaded app.tar.gz (${first.sha256.slice(0, 12)})`
		);
	});

	it('keeps the migration check: an earlier bundle without the live tag is refused', async () => {
		const { world, store, first } = await customWorld(withMarker(DO_CONFIG));
		await create(world);
		const second = await publish(
			world,
			store,
			withMarker(
				{
					durable_objects: {
						bindings: [
							{ name: 'ROOM', class_name: 'Room' },
							{ name: 'LOBBY', class_name: 'Lobby' }
						]
					},
					migrations: [
						{ tag: 'v1', new_sqlite_classes: ['Room'] },
						{ tag: 'v2', new_sqlite_classes: ['Lobby'] }
					]
				},
				'v2'
			)
		);
		await update(world, second.releaseId, first.releaseId);
		const outcome = await rollBack(world, first.releaseId, second.releaseId);
		expect(outcome).toMatchObject({ status: 'failed' });
		expect((outcome as { reason: string }).reason).toContain('migration_downgrade');
		expect(live(world).tags).toContain(`v:${second.releaseId}`);
	});

	it('refuses a release that belongs to another organization', async () => {
		const { world, store, first } = await customWorld();
		await create(world);
		const foreign = await publish(
			world,
			store,
			withMarker({}, 'theirs'),
			'theirs.tar.gz',
			`org_${'x'.repeat(26)}`
		);
		const outcome = await rollBack(world, foreign.releaseId, first.releaseId);
		expect(outcome).toMatchObject({ status: 'failed' });
		expect((outcome as { reason: string }).reason).toContain('release_unknown');
		expect(live(world).tags).toContain(`v:${first.releaseId}`);
	});
});

describe('no bundle bytes in any record', () => {
	it('keeps the marker out of every table after a create, an update and a rollback', async () => {
		const { world, store, first } = await customWorld();
		const input = JSON.stringify(world.input);
		await create(world);
		const second = await publish(world, store, withMarker({}, 'v2'), 'app-2.tar.gz');
		await update(world, second.releaseId, first.releaseId);
		await rollBack(world, first.releaseId, second.releaseId);
		expect(input).not.toContain(MARKER);
		const tables = world.sqlite
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as { name: string }[];
		const leaks: string[] = [];
		let rows = 0;
		for (const { name } of tables) {
			for (const row of world.sqlite.prepare(`SELECT * FROM "${name}"`).all()) {
				rows++;
				const text = JSON.stringify(row, (_key, value) =>
					value instanceof Uint8Array ? new TextDecoder().decode(value) : value
				);
				if (text.includes(MARKER)) leaks.push(name);
			}
		}
		expect(rows).toBeGreaterThan(10);
		expect(leaks).toEqual([]);
		// the bundle is in the bucket, which is where it belongs
		const stored = [...store.objects.values()].some((bytes) =>
			new TextDecoder().decode(bytes).includes(MARKER)
		);
		expect(stored).toBe(true);
	});
});

describe('purging a custom site', () => {
	async function twoSites() {
		const { world, store, first } = await customWorld();
		await create(world);
		const second = await publish(world, store, withMarker({}, 'v2'), 'app-2.tar.gz');
		await update(world, second.releaseId, first.releaseId);
		const other = `site_${'t'.repeat(26)}`;
		world.sqlite
			.prepare(
				`INSERT INTO sites (id, organization_id, name, plane, state, account_id, category, config,
				 release_id, created_at, updated_at)
				 VALUES (?, ?, 'Other', 'managed', 'active', ?, 'workers', 'managed', ?, 1, 1)`
			)
			.run(other, world.orgId, world.accountId, first.releaseId);
		return { world, store, first, second, other };
	}

	const keysOf = (store: Bucket, id: string) =>
		[...store.objects.keys()].filter((key) => key.startsWith(`releases/${id}/`));

	it('deletes the bundle that no other site names and keeps the one a live site shares', async () => {
		const { world, store, first, second } = await twoSites();
		const purge = customBundlesOf(world.db, store);
		expect(await purge.purgeFor(world.siteId)).toEqual([second.releaseId]);
		expect(keysOf(store, second.releaseId)).toEqual([]);
		expect(store.objects.has(customKeys.archive(world.orgId, second.sha256))).toBe(false);
		expect(keysOf(store, first.releaseId).length).toBeGreaterThan(0);
		expect(store.objects.has(customKeys.archive(world.orgId, first.sha256))).toBe(true);
		const left = world.sqlite.prepare('SELECT id FROM custom_releases').all();
		expect(left).toEqual([{ id: first.releaseId }]);
	});

	it('deletes every bundle once the other site is purged too', async () => {
		const { world, store, first, second, other } = await twoSites();
		world.sqlite.prepare("UPDATE sites SET state = 'deleted' WHERE id = ?").run(other);
		const removed = await customBundlesOf(world.db, store).purgeFor(world.siteId);
		expect(removed.sort()).toEqual([first.releaseId, second.releaseId].sort());
		expect([...store.objects.keys()]).toEqual([]);
		expect(world.sqlite.prepare('SELECT id FROM custom_releases').all()).toEqual([]);
	});

	it('leaves a bundle alone when a tombstoned site still names it in its history', async () => {
		const { world, store, first, other } = await twoSites();
		world.sqlite
			.prepare("UPDATE sites SET state = 'tombstoned', release_id = NULL WHERE id = ?")
			.run(other);
		world.sqlite
			.prepare(
				`INSERT INTO site_revisions (id, organization_id, site_id, kind, release_id, created_at)
				 VALUES ('rev_other', ?, ?, 'release', ?, 1)`
			)
			.run(world.orgId, other, first.releaseId);
		await customBundlesOf(world.db, store).purgeFor(world.siteId);
		expect(keysOf(store, first.releaseId).length).toBeGreaterThan(0);
	});

	it('does nothing for a site that never ran a bundle and is safe to repeat', async () => {
		const { world, store } = await twoSites();
		const purge = customBundlesOf(world.db, store);
		expect(await purge.purgeFor(`site_${'z'.repeat(26)}`)).toEqual([]);
		const once = await purge.purgeFor(world.siteId);
		expect(once.length).toBe(1);
		expect(await purge.purgeFor(world.siteId)).toEqual([]);
	});
});
