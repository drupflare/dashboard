import type { Plan } from '@contracts/operations';
import {
	scriptName,
	type SiteConfig,
	type SiteKind,
	type SitePlane,
	type SiteRing
} from '@contracts/sites';
import {
	bundleKeys,
	checkAssetBytes,
	checkMetadataBytes,
	checkModuleBytes,
	planChunks,
	validateBundle,
	type BundleManifest
} from '../bundle';
import {
	buildDescriptor,
	DescriptorError,
	migrationTagOfTags,
	releaseOfTags,
	UNTAGGED_MIGRATION_TAG,
	type RecipeBindings
} from '../descriptor';
import { buildPlan, observe, setCursor, setVerification, transition } from '../operations/state';
import { claimScript, ownedPutScript, siteTag, type Claim } from '../ownership';
import type { EngineDeps } from '../ports';
import { PermanentError, StepFailed, type StepRunner } from '../step';
import {
	acquireLease,
	closeFailed,
	describeFailure,
	fenced,
	finishSuccess,
	plainStep,
	releaseLease,
	runStep,
	startOperation,
	type Ctx,
	type Outcome,
	type RunOptions
} from './common';
import { SiteCheckError } from './site-create';

export interface SiteUpgradeInput {
	operationId: string;
	site: {
		id: string;
		orgId: string;
		kind: SiteKind;
		plane: SitePlane;
		config: SiteConfig;
		ring: SiteRing;
		plan: string;
		accountId: string;
	};
	hostname: string;
	// the release to move to
	releaseId: string;
	// the site row's record of what it runs; null for a site made before the row kept one
	currentRelease: string | null;
	probe?: { path: string; expectStatus: number; auth?: 'owner-token' };
	recipe?: RecipeBindings;
	chunkBytes?: number;
}

interface Preflight {
	// the release the live script carries, which a rollback goes back to
	previous: string;
	// the migration tag the live script is at; null when its release has no migrations
	previousTag: string | null;
}

export function planSiteUpgrade(
	input: Pick<SiteUpgradeInput, 'site' | 'releaseId' | 'currentRelease'>
): Plan {
	return buildPlan({
		type: 'site.upgrade',
		targetIds: [input.site.id],
		preconditions: [
			`${input.site.id} is active and answers its probe`,
			`release ${input.releaseId} is published`
		],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'preflight', name: 'Check the site and the release' },
			{ id: 'assets', name: 'Upload changed static assets' },
			{ id: 'upload-script', name: 'Upload the script' },
			{ id: 'verify', name: 'Probe the site' },
			{ id: 'finish', name: 'Record the release' }
		],
		rollbackPoint: input.currentRelease
	});
}

// the code is never rolled back across a migration the old code cannot read, so a target that does
// not list the site's latest tag is refused before anything changes
export function migrationRefusal(
	recorded: string | null,
	target: readonly string[]
): string | null {
	if (recorded === null || target.includes(recorded)) return null;
	return `the site is at migration ${recorded}, which the release does not list (${target.join(', ') || 'none'})`;
}

const claimOf = (ctx: Ctx, input: SiteUpgradeInput): Claim => ({
	siteId: input.site.id,
	accountId: input.site.accountId,
	operationId: ctx.operationId,
	plane: input.site.plane
});

async function loadManifest(deps: EngineDeps, releaseId: string): Promise<BundleManifest> {
	return validateBundle(await deps.releases.manifest(releaseId), deps.config.limits);
}

async function loadBundle(deps: EngineDeps, releaseId: string) {
	const manifest = await loadManifest(deps, releaseId);
	await checkMetadataBytes(manifest, await deps.releases.part(bundleKeys.metadata(releaseId)));
	const modules: { module: BundleManifest['modules'][number]; bytes: Uint8Array }[] = [];
	for (const module of manifest.modules) {
		const bytes = await deps.releases.part(bundleKeys.module(releaseId, module.name));
		await checkModuleBytes(module, bytes);
		modules.push({ module, bytes });
	}
	return { manifest, modules };
}

// the site's own resources, as the ledger recorded them; nothing is created here
async function descriptorFor(
	deps: EngineDeps,
	input: SiteUpgradeInput,
	releaseId: string,
	assetsToken?: string
) {
	const resources = (await deps.ledger.live(input.site.id)).flatMap((row) =>
		row.providerId === null || (row.kind !== 'kv' && row.kind !== 'r2' && row.kind !== 'd1')
			? []
			: [
					{
						siteId: row.siteId,
						kind: row.kind,
						binding: row.binding,
						providerId: row.providerId
					}
				]
	);
	try {
		return buildDescriptor({
			config: input.site.config,
			site: input.site,
			resources,
			secrets: {},
			release: { id: releaseId, assetsToken },
			recipe: input.recipe
		});
	} catch (error) {
		if (error instanceof DescriptorError) {
			throw new PermanentError(`descriptor_${error.code}`, error.message);
		}
		throw error;
	}
}

// health through the probe the create used, then the front page, both through the real hostname
async function checkSite(ctx: Ctx, input: SiteUpgradeInput): Promise<void> {
	const { custody, site } = ctx.deps;
	const probe = input.probe ?? { path: '/', expectStatus: 200 };
	let answered: { status: number };
	if (probe.auth === 'owner-token') {
		const { ownerTokenId } = await custody.sealed(input.site.id);
		if (ownerTokenId === null) {
			throw new PermanentError(
				'probe_needs_owner_token',
				'the probe needs the owner token and none is sealed'
			);
		}
		answered = await custody.withOwnerToken(input.site.id, ownerTokenId, (bearer) =>
			site.probe(input.hostname, probe.path, probe.expectStatus, { bearer })
		);
	} else {
		answered = await site.probe(input.hostname, probe.path, probe.expectStatus);
	}
	if (answered.status !== probe.expectStatus) {
		throw new SiteCheckError('the probe', answered.status, String(probe.expectStatus));
	}
	if (probe.path === '/') return;
	const front = await site.probe(input.hostname, '/', 200);
	if (front.status !== 200) throw new SiteCheckError('the front page', front.status, '200');
}

// #region forward steps

async function preflight(ctx: Ctx, input: SiteUpgradeInput): Promise<Preflight> {
	const { deps } = ctx;
	return runStep(ctx, 'preflight', 'preflight', async () => {
		await fenced(ctx);
		if (input.site.plane !== 'managed') {
			throw new PermanentError('unsupported_plane', 'only a managed site is updated here');
		}
		if ((await deps.store.siteState(input.site.id)) !== 'active') {
			throw new PermanentError('site_not_active', `${input.site.id} is not active`);
		}
		await claimScript(deps, claimOf(ctx, input));
		const info = await deps.cloudflare.getScript(scriptName(input.site.id));
		if (info === null || !info.tags.includes(siteTag(input.site.id))) {
			throw new PermanentError('script_missing', `${input.site.id} has no script of its own`);
		}
		const previous = releaseOfTags(info.tags);
		if (previous === null) {
			throw new PermanentError(
				'no_rollback_target',
				'the live script does not say which release it runs, so it could not be put back'
			);
		}
		if (previous === input.releaseId) {
			throw new PermanentError('up_to_date', `${input.site.id} already runs ${previous}`);
		}

		await checkSite(ctx, input);

		await loadBundle(deps, input.releaseId);
		// the release to go back to has to be readable now, not after the update broke the site
		await loadBundle(deps, previous);

		const target = await descriptorFor(deps, input, input.releaseId);
		const targetTags = (target.metadata.migrations ?? []).flatMap((migration) =>
			migration.tag === undefined ? [] : [migration.tag]
		);
		const recorded =
			migrationTagOfTags(info.tags) ??
			(targetTags.length === 0 ? null : UNTAGGED_MIGRATION_TAG);
		const refusal = migrationRefusal(recorded, targetTags);
		if (refusal !== null) throw new PermanentError('migration_downgrade', refusal);
		return { previous, previousTag: recorded };
	});
}

const stepOf = <T>(
	ctx: Ctx,
	planStep: string | null,
	name: string,
	work: () => Promise<T>,
	options?: RunOptions
) => (planStep === null ? plainStep(ctx, name, work) : runStep(ctx, name, planStep, work, options));

// the asset session opens on the existing script, and the API lists only the files it does not hold
// yet; a rollback runs it again under its own step names, which a workflow keeps apart
async function uploadAssets(
	ctx: Ctx,
	input: SiteUpgradeInput,
	releaseId: string,
	prefix: string,
	planStep: string | null
): Promise<string> {
	const { deps } = ctx;
	const script = scriptName(input.site.id);
	const chunkBytes = input.chunkBytes ?? deps.config.chunkBytes;

	const session = await stepOf(
		ctx,
		planStep,
		`${prefix}assets.session`,
		async () => {
			await fenced(ctx);
			await claimScript(deps, claimOf(ctx, input));
			const manifest = await loadManifest(deps, releaseId);
			const sizes = new Map(manifest.assets.map((asset) => [asset.hash, asset.size]));
			const started = await deps.cloudflare.startAssetSession(
				script,
				Object.fromEntries(
					manifest.assets.map((asset) => [
						asset.path,
						{ hash: asset.hash, size: asset.size }
					])
				)
			);
			const chunks = planChunks(
				started.buckets,
				(hash) => {
					const size = sizes.get(hash);
					if (size === undefined) {
						throw new PermanentError(
							'unknown_asset',
							`the session asked for unlisted ${hash}`
						);
					}
					return size;
				},
				chunkBytes
			);
			return { jwt: started.jwt, chunks, openedAt: deps.now() };
		},
		{ finish: false }
	);

	let token = session.jwt;
	for (const [index, chunk] of session.chunks.entries()) {
		const before = token;
		token =
			(await stepOf(
				ctx,
				planStep,
				`${prefix}assets.upload.${index}`,
				async () => {
					await fenced(ctx);
					if (deps.now() - session.openedAt > deps.config.assetSessionMs) {
						throw new PermanentError(
							'asset_session_expired',
							'the asset upload session ran out'
						);
					}
					const manifest = await loadManifest(deps, releaseId);
					const byHash = new Map(manifest.assets.map((asset) => [asset.hash, asset]));
					const files: { hash: string; bytes: Uint8Array }[] = [];
					for (const hash of chunk) {
						const asset = byHash.get(hash);
						if (asset === undefined) {
							throw new PermanentError(
								'unknown_asset',
								`${hash} is not in the manifest`
							);
						}
						const bytes = await deps.releases.part(bundleKeys.asset(releaseId, hash));
						await checkAssetBytes(asset, bytes);
						files.push({ hash, bytes });
					}
					const returned = await deps.cloudflare.uploadAssetBucket(before, files);
					if (planStep !== null) {
						await deps.store.mutate(ctx.operationId, (operation) =>
							setCursor(
								operation,
								`assets:${index + 1}/${session.chunks.length}`,
								deps.now()
							)
						);
					}
					return returned || before;
				},
				{ begin: false, finish: false }
			)) || before;
	}

	const final = token;
	return stepOf(
		ctx,
		planStep,
		`${prefix}assets.complete`,
		async () => {
			if (final === '') {
				throw new PermanentError(
					'no_completion_token',
					'the asset upload returned no token'
				);
			}
			return final;
		},
		{ begin: false }
	);
}

// a script that already carries the release was uploaded by an earlier run of this step whose
// result was lost, and a second upload would name an old tag the script has moved past
async function putRelease(
	ctx: Ctx,
	input: SiteUpgradeInput,
	releaseId: string,
	assetsToken: string,
	oldTag: string | null
): Promise<void> {
	const { deps } = ctx;
	const live = await deps.cloudflare.getScript(scriptName(input.site.id));
	if (live !== null && releaseOfTags(live.tags) === releaseId) return;
	const { manifest, modules } = await loadBundle(deps, releaseId);
	const descriptor = await descriptorFor(deps, input, releaseId, assetsToken);
	await ownedPutScript(deps, claimOf(ctx, input), {
		main: manifest.mainModule,
		metadata: descriptor.metadata,
		modules,
		...(oldTag === null ? {} : { oldTag })
	});
}

async function uploadScript(
	ctx: Ctx,
	input: SiteUpgradeInput,
	assetsToken: string,
	pre: Preflight
): Promise<void> {
	await runStep(ctx, 'upload-script', 'upload-script', async () => {
		await fenced(ctx);
		await putRelease(ctx, input, input.releaseId, assetsToken, pre.previousTag);
	});
}

async function verify(ctx: Ctx, input: SiteUpgradeInput): Promise<void> {
	const { deps } = ctx;
	await runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		await checkSite(ctx, input);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
}

async function finish(ctx: Ctx, input: SiteUpgradeInput): Promise<void> {
	await runStep(ctx, 'finish', 'finish', async () => {
		await fenced(ctx);
		await ctx.deps.store.setSiteRelease(input.site.id, input.releaseId, ctx.deps.now());
	});
}

// #endregion

// #region rollback

// past upload-script the live script may already carry the new release
const MAY_HAVE_CHANGED = ['upload-script', 'verify', 'finish'];

async function note(ctx: Ctx, name: string, summary: string): Promise<void> {
	const { deps } = ctx;
	await plainStep(ctx, name, async () => {
		await deps.store.mutate(ctx.operationId, (operation) =>
			setVerification(observe(operation, summary, deps.now()), 'failed', deps.now())
		);
	});
}

async function stop(ctx: Ctx, outcome: Outcome): Promise<Outcome> {
	await releaseLease(ctx);
	return outcome;
}

async function rollback(
	ctx: Ctx,
	input: SiteUpgradeInput,
	pre: Preflight | null,
	failure: StepFailed
): Promise<Outcome> {
	const { deps } = ctx;
	const reason = describeFailure(failure);
	const closed = await closeFailed(ctx, failure);
	if (closed === 'cancelled') {
		return stop(ctx, { status: 'cancelled', reason });
	}
	if (pre === null || !MAY_HAVE_CHANGED.includes(failure.step)) {
		return stop(ctx, { status: 'failed', reason, leaked: [] });
	}

	const fence = await plainStep(ctx, 'rollback.fence', async () => {
		const epoch = ctx.epoch ?? (await deps.store.get(ctx.operationId))?.fencingEpoch ?? 0;
		if (epoch === 0) return { state: 'lost' as const, epoch };
		const verdict = await deps.leases.check(input.site.id, { holder: ctx.operationId, epoch });
		if (verdict.ok) return { state: 'held' as const, epoch };
		const regained = await deps.leases.acquire(input.site.id, {
			holder: ctx.operationId,
			purpose: ctx.purpose,
			ttlMs: deps.config.leaseTtlMs
		});
		return regained.ok
			? { state: 'held' as const, epoch: regained.epoch }
			: { state: 'lost' as const, epoch };
	});
	ctx.epoch = fence.epoch === 0 ? null : fence.epoch;
	if (fence.state === 'lost') {
		const text = `${reason}; the lease was lost, so the site was left as it is`;
		await note(ctx, 'rollback.note', text);
		return { status: 'failed', reason: text, leaked: ['code'] };
	}

	const live = await plainStep(ctx, 'rollback.read', async () => {
		const info = await deps.cloudflare.getScript(scriptName(input.site.id));
		return info === null
			? null
			: { release: releaseOfTags(info.tags), tag: migrationTagOfTags(info.tags) };
	});
	if (live === null || (live.release !== pre.previous && live.release !== input.releaseId)) {
		const text = `${reason}; the script is not what this update left, so nothing was rolled back`;
		await note(ctx, 'rollback.note', text);
		return stop(ctx, { status: 'failed', reason: text, leaked: ['code'] });
	}
	if (live.release === pre.previous) {
		const text = `${reason}; the site was not changed`;
		await note(ctx, 'rollback.note', text);
		return stop(ctx, { status: 'failed', reason: text, leaked: [] });
	}
	if (live.tag !== pre.previousTag) {
		const text = `${reason}; the update applied migration ${live.tag}, which ${pre.previous} cannot read, so the code was not rolled back`;
		await note(ctx, 'rollback.note', text);
		return stop(ctx, { status: 'failed', reason: text, leaked: ['code'] });
	}

	try {
		const token = await uploadAssets(ctx, input, pre.previous, 'rollback.', null);
		await plainStep(ctx, 'rollback.upload-script', async () => {
			await fenced(ctx);
			await putRelease(ctx, input, pre.previous, token, pre.previousTag);
		});
		await plainStep(ctx, 'rollback.verify', async () => {
			await fenced(ctx);
			await checkSite(ctx, input);
		});
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		const text = `${reason}; rollback failed: ${describeFailure(error)}`;
		await note(ctx, 'rollback.note', text);
		return stop(ctx, { status: 'failed', reason: text, leaked: ['code'] });
	}
	const text = `${reason}; rolled back to ${pre.previous}`;
	await note(ctx, 'rollback.note', text);
	return stop(ctx, { status: 'failed', reason: text, leaked: [] });
}

// #endregion

export async function runSiteUpgrade(
	step: StepRunner,
	deps: EngineDeps,
	input: SiteUpgradeInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.site.id,
		accountId: input.site.accountId,
		purpose: 'site.upgrade',
		epoch: null
	};
	let pre: Preflight | null = null;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		pre = await preflight(ctx, input);
		const token = await uploadAssets(ctx, input, input.releaseId, '', 'assets');
		await uploadScript(ctx, input, token, pre);
		await verify(ctx, input);
		await finish(ctx, input);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return rollback(ctx, input, pre, error);
	}
	await finishSuccess(ctx, `${input.site.id} runs ${input.releaseId}, up from ${pre.previous}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
