import { Budget, dispatch, Resources } from '@drupflare/workforce';
import { describe, expect, it } from 'vitest';
import { scriptName } from '../../../contracts/src/sites';
import { steppedMigrations, workforceCloudflare } from '../../../engine/src/adapters/workforce';
import { bundleKeys } from '../../../engine/src/bundle';
import type { RecipeBindings } from '../../../engine/src/descriptor';
import { freezePlan, newOperation } from '../../../engine/src/operations/state';
import { PermanentError } from '../../../engine/src/step';
import { runSiteCreate } from '../../../engine/src/workflows/site-create';
import type { SiteUpgradeInput } from '../../../engine/src/workflows/site-upgrade';
import {
	migrationRefusal,
	planSiteUpgrade,
	runSiteUpgrade
} from '../../../engine/src/workflows/site-upgrade';
import {
	beginCreate,
	Killed,
	makeBundle,
	makeRunner,
	makeWorld,
	releasesOf,
	type FakeBundle,
	type Memo,
	type RunnerScript,
	type World
} from './fakes';

const UPGRADE_ID = `op_${'u'.repeat(26)}`;

function combined(...bundles: FakeBundle[]) {
	const parts = bundles.map((bundle) => releasesOf(bundle));
	return {
		async manifest(releaseId: string) {
			const id = bundles.findIndex((bundle) => bundle.manifest.releaseId === releaseId);
			if (id < 0) throw new PermanentError('release_not_found', releaseId);
			return parts[id]!.manifest(releaseId);
		},
		async part(key: string) {
			for (const part of parts) {
				try {
					return await part.part(key);
				} catch (error) {
					if (!(error instanceof PermanentError)) throw error;
				}
			}
			throw new PermanentError('release_part_missing', key);
		}
	};
}

// a live site on v1.0.4 and a second release v1.0.5 with two more assets
async function liveSite(options: { recipe?: RecipeBindings } = {}) {
	const world = await makeWorld();
	await beginCreate(world);
	const created = makeRunner(new Map());
	const outcome = await runSiteCreate(created.runner, world.deps, world.input);
	expect(outcome).toEqual({ status: 'succeeded' });
	const next = await makeBundle('v1.0.5', 7);
	world.deps.releases = combined(world.bundle, next);
	const input: SiteUpgradeInput = {
		operationId: UPGRADE_ID,
		site: {
			id: world.siteId,
			orgId: world.orgId,
			kind: 'drupal',
			plane: 'managed',
			config: 'managed',
			ring: 'R1',
			plan: 'free',
			accountId: world.accountId
		},
		hostname: world.input.hostname,
		releaseId: 'v1.0.5',
		currentRelease: 'v1.0.4',
		probe: { path: '/health', expectStatus: 200, auth: 'owner-token' },
		...(options.recipe === undefined ? {} : { recipe: options.recipe })
	};
	const frozen = await freezePlan(planSiteUpgrade(input));
	await world.store.begin({
		operation: newOperation({
			id: UPGRADE_ID,
			orgId: world.orgId,
			idempotencyKey: 'upgrade-1',
			frozen,
			now: world.clock.now()
		}),
		accountId: world.accountId,
		siteId: world.siteId
	});
	return { world, input, next, createdUploads: world.cf.uploads.length };
}

function attempt(
	world: World,
	input: SiteUpgradeInput,
	memo: Memo = new Map(),
	script: RunnerScript = {}
) {
	const { runner, executed } = makeRunner(memo, script);
	return { executed, done: runSiteUpgrade(runner, world.deps, input) };
}

const live = (world: World) => world.cf.scripts.get(scriptName(world.siteId))!;
const releaseRow = (world: World) =>
	(
		world.sqlite.prepare('SELECT release_id FROM sites WHERE id = ?').get(world.siteId) as {
			release_id: string | null;
		}
	).release_id;

// a release whose script answers 500 once it is the live one
function breakRelease(world: World, releaseId: string) {
	const real = world.deps.site.probe;
	world.deps.site = {
		...world.deps.site,
		probe: async (host, path, expectStatus, auth) =>
			live(world).tags.includes(`v:${releaseId}`)
				? { status: 500 }
				: real(host, path, expectStatus, auth)
	};
}

const lastTwo = (tags: string[]) => tags.filter((tag) => /^[vm]:/.test(tag)).sort();

const THREE: RecipeBindings = {
	durableObjects: [
		{ name: 'SITE', class_name: 'SitePhpDurableObject' },
		{ name: 'RENDER_LANES', class_name: 'RenderLane' }
	],
	migrations: [
		{ tag: 'v1', new_sqlite_classes: ['SitePhpDurableObject'] },
		{ tag: 'v2', new_sqlite_classes: ['RenderLane'] },
		{ tag: 'v3', new_sqlite_classes: ['Extra'] }
	],
	crons: [],
	sendEmail: 'SEND_EMAIL',
	versionMetadata: 'CF_VERSION_METADATA'
};

const ONE: RecipeBindings = { ...THREE, migrations: THREE.migrations.slice(0, 1) };

describe('an uninterrupted update', () => {
	it('uploads only the changed assets, keeps the site own resources and records the release', async () => {
		const { world, input, createdUploads } = await liveSite();
		const before = {
			account: world.cf.snapshot(),
			resources: await world.ledger.all(world.siteId),
			authority: world.authority.stateOf(world.siteId),
			creates: world.cf.counts.create
		};
		const run = attempt(world, input);
		expect(await run.done).toEqual({ status: 'succeeded' });
		expect(run.executed).toEqual([
			'start',
			'lease',
			'preflight',
			'assets.session',
			'assets.upload.0',
			'assets.complete',
			'upload-script',
			'verify',
			'finish',
			'finalize',
			'release-lease'
		]);
		const after = world.cf.snapshot();
		expect(after.assets.length - before.account.assets.length).toBe(2);
		expect(after.kv).toEqual(before.account.kv);
		expect(after.r2).toEqual(before.account.r2);
		expect(world.cf.counts.create).toBe(before.creates);
		expect(await world.ledger.all(world.siteId)).toHaveLength(before.resources.length);
		expect(world.authority.stateOf(world.siteId)).toEqual(before.authority);
		expect(world.cf.uploads).toHaveLength(createdUploads + 1);
		const sent = world.cf.uploads.at(-1)!;
		expect(sent.oldTag).toBe('v2');
		expect(lastTwo(sent.tags)).toEqual(['m:v2', 'v:v1.0.5']);
		expect(releaseRow(world)).toBe('v1.0.5');
		const operation = await world.store.get(UPGRADE_ID);
		expect(operation).toMatchObject({ status: 'succeeded', verification: 'passed' });
		expect(operation?.steps.every((step) => step.state === 'succeeded')).toBe(true);
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('records the release on a create too', async () => {
		const { world } = await liveSite();
		expect(releaseRow(world)).toBe('v1.0.4');
	});

	it('records the tag the create uploaded, so the next update knows where the script is', async () => {
		const { world } = await liveSite();
		expect(lastTwo(live(world).tags)).toEqual(['m:v2', 'v:v1.0.4']);
	});
});

describe('what the preflight refuses', () => {
	async function refused(
		prepare: (ctx: Awaited<ReturnType<typeof liveSite>>) => void | Promise<void>,
		expected: string,
		untouched = true
	) {
		const ctx = await liveSite();
		await prepare(ctx);
		const { world, input, createdUploads } = ctx;
		const run = attempt(world, input);
		const outcome = await run.done;
		expect(outcome.status).toBe('failed');
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain(expected);
		expect(outcome.leaked).toEqual([]);
		expect(world.cf.uploads).toHaveLength(createdUploads);
		expect(run.executed).not.toContain('assets.session');
		if (untouched) expect(live(world).tags).toContain('v:v1.0.4');
		expect(releaseRow(world)).toBe('v1.0.4');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	}

	it('a site that already runs the release', async () => {
		await refused(({ input }) => void (input.releaseId = 'v1.0.4'), 'up_to_date');
	});

	it('a site that does not answer its probe', async () => {
		await refused(
			({ world }) => void (world.site.answers.probe = 503),
			'the probe answered 503'
		);
	});

	it('a site that is not active', async () => {
		await refused(
			({ world }) => world.store.setSiteState(world.siteId, 'suspended', 1),
			'site_not_active'
		);
	});

	it('a target release whose module is missing from storage', async () => {
		await refused(({ world }) => {
			const releases = world.deps.releases;
			world.deps.releases = {
				manifest: releases.manifest,
				part: async (key) => {
					if (key === bundleKeys.module('v1.0.5', 'php.wasm')) {
						throw new PermanentError('release_part_missing', key);
					}
					return releases.part(key);
				}
			};
		}, 'release_part_missing');
	});

	it('a target release that is not published', async () => {
		await refused(({ input }) => void (input.releaseId = 'v9.9.9'), 'release_not_found');
	});

	it('a live release that could not be put back', async () => {
		await refused(({ world }) => {
			const releases = world.deps.releases;
			world.deps.releases = {
				manifest: async (id) => {
					if (id === 'v1.0.4') throw new PermanentError('release_not_found', id);
					return releases.manifest(id);
				},
				part: releases.part
			};
		}, 'release_not_found');
	});

	it('a script someone else changed', async () => {
		await refused(
			({ world }) => world.cf.tamper(scriptName(world.siteId), { tags: ['team:web'] }),
			'script_changed',
			false
		);
	});

	it('a script that does not say which release it runs', async () => {
		await refused(
			({ world }) => {
				world.cf.tamper(scriptName(world.siteId), {
					tags: live(world).tags.filter((tag) => !tag.startsWith('v:'))
				});
				// the ledger records the new version, as a later upload of ours would
				const row = world.sqlite
					.prepare("SELECT id FROM site_resources WHERE kind = 'script'")
					.get() as {
					id: string;
				};
				world.sqlite
					.prepare('UPDATE site_resources SET fingerprint = ? WHERE id = ?')
					.run(String(live(world).version), row.id);
			},
			'no_rollback_target',
			false
		);
	});

	it('a target whose migrations leave out the migration the site is at', async () => {
		await refused(({ input }) => void (input.recipe = ONE), 'migration_downgrade');
	});
});

describe('a failure before the script upload', () => {
	it('stops without a rollback when an asset is missing, leaving the live site as it was', async () => {
		const { world, input, next, createdUploads } = await liveSite();
		const missing = next.manifest.assets.at(-1)!;
		const releases = world.deps.releases;
		world.deps.releases = {
			manifest: releases.manifest,
			part: async (key) => {
				if (key === bundleKeys.asset('v1.0.5', missing.hash)) {
					throw new PermanentError('release_part_missing', key);
				}
				return releases.part(key);
			}
		};
		const run = attempt(world, input);
		const outcome = await run.done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: [] });
		expect(run.executed.some((name) => name.startsWith('rollback'))).toBe(false);
		expect(run.executed).not.toContain('upload-script');
		expect(world.cf.uploads).toHaveLength(createdUploads);
		expect(live(world).tags).toContain('v:v1.0.4');
		expect(releaseRow(world)).toBe('v1.0.4');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('does not touch the site when the upload step failed before its effect', async () => {
		const { world, input, createdUploads } = await liveSite();
		const run = attempt(world, input, new Map(), {
			failAt: { step: 'upload-script', when: 'before' }
		});
		const outcome = await run.done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: [] });
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('the site was not changed');
		expect(world.cf.uploads).toHaveLength(createdUploads);
		expect(releaseRow(world)).toBe('v1.0.4');
	});
});

describe('a failure after the script upload', () => {
	it('puts the old release back and checks the site again when the check fails', async () => {
		const { world, input, createdUploads } = await liveSite();
		breakRelease(world, 'v1.0.5');
		const run = attempt(world, input);
		const outcome = await run.done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: [] });
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('rolled back to v1.0.4');
		expect(world.cf.uploads).toHaveLength(createdUploads + 2);
		expect(lastTwo(live(world).tags)).toEqual(['m:v2', 'v:v1.0.4']);
		expect(world.cf.uploads.at(-1)!.oldTag).toBe('v2');
		expect(run.executed.slice(run.executed.indexOf('verify'))).toEqual([
			'verify',
			'fail',
			'rollback.fence',
			'rollback.read',
			'rollback.assets.session',
			'rollback.assets.complete',
			'rollback.upload-script',
			'rollback.verify',
			'rollback.note',
			'release-lease'
		]);
		expect(releaseRow(world)).toBe('v1.0.4');
		const operation = await world.store.get(UPGRADE_ID);
		expect(operation).toMatchObject({ status: 'failed', verification: 'failed' });
		expect(operation?.finalObservation?.summary).toContain('rolled back to v1.0.4');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('rolls back when the upload ran and its result was lost', async () => {
		const { world, input } = await liveSite();
		const run = attempt(world, input, new Map(), {
			failAt: { step: 'upload-script', when: 'after' }
		});
		const outcome = await run.done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: [] });
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('rolled back to v1.0.4');
		expect(live(world).tags).toContain('v:v1.0.4');
	});

	it('says the rollback failed when the old release does not answer either', async () => {
		const { world, input } = await liveSite();
		const real = world.deps.site.probe;
		let puts = 0;
		world.cf.hooks.beforePut = () => void puts++;
		world.deps.site = {
			...world.deps.site,
			probe: async (host, path, expectStatus, auth) =>
				puts > 0 ? { status: 500 } : real(host, path, expectStatus, auth)
		};
		const outcome = await attempt(world, input).done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: ['code'] });
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('rollback failed');
		expect(outcome.reason).not.toContain('rolled back to');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('says the rollback failed when the old release cannot be uploaded', async () => {
		const { world, input, createdUploads } = await liveSite();
		breakRelease(world, 'v1.0.5');
		world.cf.hooks.beforePut = () => {
			if (world.cf.uploads.length > createdUploads) throw new PermanentError('refused', 'no');
		};
		const outcome = await attempt(world, input).done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: ['code'] });
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('rollback failed');
		expect(lastTwo(live(world).tags)).toEqual(['m:v2', 'v:v1.0.5']);
	});

	it('leaves the site alone when the lease was lost', async () => {
		const { world, input, createdUploads } = await liveSite();
		breakRelease(world, 'v1.0.5');
		const real = world.deps.cloudflare;
		world.deps.cloudflare = {
			...real,
			putScript: async (name, upload) => {
				const result = await real.putScript(name, upload);
				// the holder is slow; its lease runs out and a repair takes the site
				world.clock.advance(world.deps.config.leaseTtlMs + 1);
				await world.deps.leases.acquire(world.siteId, {
					holder: 'op_repair00000000',
					purpose: 'repair.run',
					ttlMs: 60_000
				});
				return result;
			}
		};
		const outcome = await attempt(world, input).done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: ['code'] });
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('lease_lost');
		expect(outcome.reason).toContain('the lease was lost');
		expect(world.cf.uploads).toHaveLength(createdUploads + 1);
		expect(world.leases.stateOf(world.siteId).holder?.id).toBe('op_repair00000000');
	});
});

describe('the rollback guard', () => {
	it('sends the steps after the site tag when the release adds a migration', async () => {
		const { world, input } = await liveSite({ recipe: THREE });
		expect(await attempt(world, input).done).toEqual({ status: 'succeeded' });
		const sent = world.cf.uploads.at(-1)!;
		expect(sent.oldTag).toBe('v2');
		expect(lastTwo(sent.tags)).toEqual(['m:v3', 'v:v1.0.5']);
	});

	it('does not put the code back across a migration the old code cannot read', async () => {
		const { world, input, createdUploads } = await liveSite({ recipe: THREE });
		breakRelease(world, 'v1.0.5');
		const outcome = await attempt(world, input).done;
		expect(outcome).toMatchObject({ status: 'failed', leaked: ['code'] });
		if (outcome.status !== 'failed') return;
		expect(outcome.reason).toContain('applied migration v3');
		expect(outcome.reason).toContain('cannot read');
		expect(world.cf.uploads).toHaveLength(createdUploads + 1);
		expect(lastTwo(live(world).tags)).toEqual(['m:v3', 'v:v1.0.5']);
		expect(releaseRow(world)).toBe('v1.0.4');
		expect(world.leases.stateOf(world.siteId).holder).toBeNull();
	});

	it('refuses a release that lists fewer migrations than the site has', () => {
		expect(migrationRefusal('v2', ['v1'])).toContain('v2');
		expect(migrationRefusal('v2', [])).toContain('none');
		expect(migrationRefusal('v2', ['v1', 'v2'])).toBeNull();
		expect(migrationRefusal('v2', ['v1', 'v2', 'v3'])).toBeNull();
		expect(migrationRefusal(null, [])).toBeNull();
	});
});

describe('migrations on an existing script', () => {
	const list = [
		{ tag: 'v1', new_sqlite_classes: ['A'] },
		{ tag: 'v2', new_sqlite_classes: ['B'] },
		{ tag: 'v3', new_sqlite_classes: ['C'] }
	];

	it('sends every step and no old tag on a first upload', () => {
		expect(steppedMigrations(list)).toEqual({
			new_tag: 'v3',
			steps: [
				{ new_sqlite_classes: ['A'] },
				{ new_sqlite_classes: ['B'] },
				{ new_sqlite_classes: ['C'] }
			]
		});
	});

	it('sends nothing when the script is already at the last tag', () => {
		expect(steppedMigrations(list, 'v3')).toBeUndefined();
	});

	it('names the old tag and sends only the steps after it when a tag was added', () => {
		expect(steppedMigrations(list, 'v1')).toEqual({
			old_tag: 'v1',
			new_tag: 'v3',
			steps: [{ new_sqlite_classes: ['B'] }, { new_sqlite_classes: ['C'] }]
		});
		expect(steppedMigrations(list, 'v2')).toEqual({
			old_tag: 'v2',
			new_tag: 'v3',
			steps: [{ new_sqlite_classes: ['C'] }]
		});
	});

	it('refuses a script tag the list does not hold, which is a downgrade', () => {
		expect(() => steppedMigrations(list.slice(0, 2), 'v3')).toThrow(PermanentError);
		expect(() => steppedMigrations([], 'v1')).not.toThrow();
		expect(steppedMigrations([], 'v1')).toBeUndefined();
	});
});

describe('the upload an update sends', () => {
	async function sentMetadata(oldTag: string | undefined) {
		let body: unknown = null;
		let contentType = '';
		const fetcher = async (_input: string | URL | Request, init?: RequestInit) => {
			if (init?.method === 'PUT') {
				body = init.body;
				contentType = new Headers(init.headers).get('content-type') ?? '';
			}
			return new Response(JSON.stringify({ success: true, result: { id: 'x' } }), {
				headers: { 'content-type': 'application/json' }
			});
		};
		let clock = 0;
		const sleep = async (ms: number) => void (clock += ms);
		const plane = dispatch({
			accountId: 'a'.repeat(32),
			token: 'fake-token',
			namespace: 'ns',
			fetch: fetcher,
			retries: 0,
			sleep,
			now: () => clock,
			budget: new Budget({ now: () => clock, sleep })
		});
		const cloudflare = workforceCloudflare(plane, new Resources(plane.http, 'a'.repeat(32)));
		const bundle = await makeBundle();
		await cloudflare.putScript('s-x', {
			main: 'index.js',
			metadata: { migrations: THREE.migrations },
			modules: bundle.manifest.modules.map((module) => ({
				module,
				bytes: bundle.parts.get(bundleKeys.module('v1.0.4', module.name))!
			})),
			...(oldTag === undefined ? {} : { oldTag })
		});
		const form = await new Response(body as BodyInit, {
			headers: { 'content-type': contentType }
		}).formData();
		return JSON.parse(String(form.get('metadata'))) as { migrations?: unknown };
	}

	it('names the old tag and the steps after it', async () => {
		expect((await sentMetadata('v2')).migrations).toEqual({
			old_tag: 'v2',
			new_tag: 'v3',
			steps: [{ new_sqlite_classes: ['Extra'] }]
		});
	});

	it('leaves migrations out when the script is at the last tag', async () => {
		expect(await sentMetadata('v3')).not.toHaveProperty('migrations');
	});

	it('refuses an old tag the release does not list, before any request', async () => {
		await expect(sentMetadata('v0')).rejects.toThrow(PermanentError);
	});
});

describe('kill and resume', () => {
	async function reference() {
		const ctx = await liveSite();
		const run = attempt(ctx.world, ctx.input);
		await run.done;
		return { steps: run.executed, uploads: ctx.world.cf.uploads.length };
	}

	it('never uploads the script twice, whichever step it dies in', async () => {
		const ref = await reference();
		for (let j = 1; j <= ref.steps.length; j++) {
			const { world, input } = await liveSite();
			const memo: Memo = new Map();
			await expect(
				attempt(world, input, memo, { killDuring: j }).done
			).rejects.toBeInstanceOf(Killed);
			const outcome = await attempt(world, input, memo).done;
			expect(outcome, `killed during ${ref.steps[j - 1]}`).toEqual({ status: 'succeeded' });
			expect(world.cf.uploads.length, `killed during ${ref.steps[j - 1]}`).toBe(ref.uploads);
			expect(releaseRow(world)).toBe('v1.0.5');
			expect(world.leases.stateOf(world.siteId).holder).toBeNull();
		}
	});

	it('resumes after a kill before each step and ends the same', async () => {
		const ref = await reference();
		for (let k = 0; k < ref.steps.length; k++) {
			const { world, input } = await liveSite();
			const memo: Memo = new Map();
			await expect(attempt(world, input, memo, { killAfter: k }).done).rejects.toBeInstanceOf(
				Killed
			);
			expect(await attempt(world, input, memo).done, `killed after ${k}`).toEqual({
				status: 'succeeded'
			});
			expect(world.cf.uploads.length).toBe(ref.uploads);
		}
	});
});
