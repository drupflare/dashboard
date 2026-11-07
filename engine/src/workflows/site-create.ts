import { canonicalJson, sha256Hex, toBase64Url } from '@contracts/common';
import type { Plan } from '@contracts/operations';
import type { AuthorityState, RiskClass } from '@contracts/site-auth';
import {
	scriptName,
	type SiteCategory,
	type SiteConfig,
	type SiteKind,
	type SitePlane,
	type SiteRing
} from '@contracts/sites';
import { checkHeadroom, readAccountUsage } from '../account-usage';
import {
	bundleKeys,
	checkAssetBytes,
	checkMetadataBytes,
	checkModuleBytes,
	planChunks,
	validateBundle,
	type BundleManifest
} from '../bundle';
import { CustodySealError, refuseSuppliedPassword } from '../custody';
import { buildDescriptor, DescriptorError } from '../descriptor';
import {
	buildPlan,
	observe,
	setCursor,
	setVerification,
	stepOf,
	transition
} from '../operations/state';
import {
	attachRoute,
	claimResource,
	claimScript,
	ownedPutScript,
	rollbackRow,
	type Claim
} from '../ownership';
import type { EngineDeps, SiteCall } from '../ports';
import type { ResourcePlan } from '../provision-plan';
import { planResources } from '../provision-plan';
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
	type Outcome
} from './common';

export interface SiteCreateInput {
	operationId: string;
	site: {
		id: string;
		orgId: string;
		name: string;
		kind: SiteKind;
		category: SiteCategory;
		plane: SitePlane;
		config: SiteConfig;
		ring: SiteRing;
		plan: string;
		accountId: string;
	};
	subdomain: string;
	hostname: string;
	// set when the hostname sits on a customer's zone and needs a route there
	zoneId?: string;
	releaseId: string;
	database?: boolean;
	authority: {
		risk: RiskClass;
		limits: Record<string, number>;
		accessRuleHash: string;
		epoch?: number;
	};
	firstRun?: SiteCall;
	// auth names how the probe proves itself; the owner token is read from custody, never passed in
	probe?: { path: string; expectStatus: number; auth?: 'owner-token' };
	chunkBytes?: number;
}

export interface FirstRunSealed {
	// null when the secrets were already sealed and the site was not called again
	status: number | null;
	ownerTokenId: string | null;
	pendingSecretId: string | null;
	// what the site said it made; plain text, and null when the call was not answered here
	adminName?: string | null;
	adminMail?: string | null;
}

export class NameUnavailableError extends PermanentError {
	constructor(name: string, answer: string) {
		super(`name_${answer.replaceAll('-', '_')}`, `${name} cannot be reserved: ${answer}`);
	}
}

export class SiteCheckError extends Error {
	constructor(what: string, status: number, wanted: string) {
		super(`${what} answered ${status}, wanted ${wanted}`);
		this.name = 'SiteCheckError';
	}
}

export function planSiteCreate(input: SiteCreateInput): Plan {
	const { site } = input;
	const resources = planResources(site, site.config, { database: input.database });
	return buildPlan({
		type: 'site.create',
		targetIds: [site.id],
		preconditions: [`${input.subdomain} is free`, `release ${input.releaseId} is published`],
		steps: [
			{ id: 'lease', name: 'Take the site writer lease' },
			{ id: 'reserve-name', name: `Reserve ${input.subdomain}` },
			...resources.create.map((resource) => ({
				id: `resource.${resource.binding}`,
				name: `Create ${resource.kind} ${resource.name}`
			})),
			{ id: 'assets', name: 'Upload static assets' },
			{ id: 'upload-script', name: 'Upload the script' },
			{ id: 'authority', name: 'Write site authority' },
			{ id: 'route', name: `Route ${input.hostname}` },
			...(input.firstRun ? [{ id: 'first-run', name: 'Run the first-run call' }] : []),
			{ id: 'verify', name: 'Probe the site' },
			{ id: 'activate', name: 'Mark the site active' }
		],
		rollbackPoint: null
	});
}

async function loadManifest(deps: EngineDeps, releaseId: string): Promise<BundleManifest> {
	return validateBundle(await deps.releases.manifest(releaseId), deps.config.limits);
}

function desiredAuthority(input: SiteCreateInput): AuthorityState {
	return {
		siteId: input.site.id,
		epoch: input.authority.epoch ?? 1,
		generation: 1,
		state: 'active',
		risk: input.authority.risk,
		limits: input.authority.limits,
		accessRuleHash: input.authority.accessRuleHash
	} as AuthorityState;
}

// #region forward steps

async function reserveName(ctx: Ctx, input: SiteCreateInput): Promise<void> {
	await runStep(ctx, 'reserve-name', 'reserve-name', async () => {
		await fenced(ctx);
		const answer = await ctx.deps.names.reserve(input.subdomain, input.site.id);
		if (answer !== 'reserved') throw new NameUnavailableError(input.subdomain, answer);
	});
}

const claimOf = (ctx: Ctx, input: SiteCreateInput): Claim => ({
	siteId: input.site.id,
	accountId: input.site.accountId,
	operationId: ctx.operationId,
	plane: input.site.plane
});

// the first resource also reads the account's usage, so a create that cannot fit stops before it
// changes anything
async function createResource(
	ctx: Ctx,
	input: SiteCreateInput,
	resource: ResourcePlan['create'][number],
	plan: ResourcePlan | null
): Promise<void> {
	const { deps } = ctx;
	const id = `resource.${resource.binding}`;
	await runStep(ctx, id, id, async () => {
		await fenced(ctx);
		if (plan !== null) {
			const started = (await deps.ledger.live(input.site.id)).length > 0;
			if (!started) {
				checkHeadroom(plan, await readAccountUsage(deps.cloudflare), deps.config.account);
			}
		}
		await claimResource(deps, claimOf(ctx, input), resource);
	});
}

// the completion token goes into the script's metadata, so assets come before the script
async function uploadAssets(ctx: Ctx, input: SiteCreateInput): Promise<string> {
	const { deps } = ctx;
	const script = scriptName(input.site.id);
	const chunkBytes = input.chunkBytes ?? deps.config.chunkBytes;

	const session = await runStep(
		ctx,
		'assets.session',
		'assets',
		async () => {
			await fenced(ctx);
			await claimScript(deps, claimOf(ctx, input));
			const manifest = await loadManifest(deps, input.releaseId);
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
			return { jwt: started.jwt, complete: started.complete, chunks, openedAt: deps.now() };
		},
		{ finish: false }
	);

	let token = session.jwt;
	for (const [index, chunk] of session.chunks.entries()) {
		const before = token;
		token =
			(await runStep(
				ctx,
				`assets.upload.${index}`,
				'assets',
				async () => {
					await fenced(ctx);
					if (deps.now() - session.openedAt > deps.config.assetSessionMs) {
						throw new PermanentError(
							'asset_session_expired',
							'the asset upload session ran out'
						);
					}
					const manifest = await loadManifest(deps, input.releaseId);
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
						const bytes = await deps.releases.part(
							bundleKeys.asset(input.releaseId, hash)
						);
						await checkAssetBytes(asset, bytes);
						files.push({ hash, bytes });
					}
					const returned = await deps.cloudflare.uploadAssetBucket(before, files);
					await deps.store.mutate(ctx.operationId, (operation) =>
						setCursor(
							operation,
							`assets:${index + 1}/${session.chunks.length}`,
							deps.now()
						)
					);
					return returned || before;
				},
				{ begin: false, finish: false }
			)) || before;
	}

	const final = token;
	return runStep(
		ctx,
		'assets.complete',
		'assets',
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

async function uploadScript(ctx: Ctx, input: SiteCreateInput, assetsToken: string): Promise<void> {
	const { deps } = ctx;
	await runStep(ctx, 'upload-script', 'upload-script', async () => {
		await fenced(ctx);
		const manifest = await loadManifest(deps, input.releaseId);
		await checkMetadataBytes(
			manifest,
			await deps.releases.part(bundleKeys.metadata(input.releaseId))
		);
		const modules: { module: (typeof manifest.modules)[number]; bytes: Uint8Array }[] = [];
		for (const module of manifest.modules) {
			const bytes = await deps.releases.part(bundleKeys.module(input.releaseId, module.name));
			await checkModuleBytes(module, bytes);
			modules.push({ module, bytes });
		}
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
		let descriptor;
		try {
			descriptor = buildDescriptor({
				config: input.site.config,
				site: input.site,
				resources,
				secrets: {},
				release: { id: manifest.releaseId, assetsToken }
			});
		} catch (error) {
			if (error instanceof DescriptorError) {
				throw new PermanentError(`descriptor_${error.code}`, error.message);
			}
			throw error;
		}
		await ownedPutScript(deps, claimOf(ctx, input), {
			main: manifest.mainModule,
			metadata: descriptor.metadata,
			modules
		});
	});
}

async function applyAuthority(ctx: Ctx, input: SiteCreateInput): Promise<void> {
	const { authority } = ctx.deps;
	await runStep(ctx, 'authority', 'authority', async () => {
		await fenced(ctx);
		const desired = desiredAuthority(input);
		const current = await authority.read(input.site.id);
		if (current !== null && canonicalJson(current) === canonicalJson(desired)) return;
		await authority.apply(
			current === null ? desired : { ...desired, generation: current.generation + 1 }
		);
	});
}

async function putRoute(ctx: Ctx, input: SiteCreateInput): Promise<void> {
	await runStep(ctx, 'route', 'route', async () => {
		await fenced(ctx);
		// the customer's zone is read and checked before anything of ours is written
		if (input.site.plane !== 'managed' && input.zoneId !== undefined) {
			await attachRoute(ctx.deps, claimOf(ctx, input), {
				zoneId: input.zoneId,
				hostname: input.hostname
			});
		}
		await ctx.deps.authority.putHost(input.hostname, {
			siteId: input.site.id,
			script: scriptName(input.site.id),
			epoch: input.authority.epoch ?? 1
		});
	});
}

async function sealing<T>(what: string, write: () => Promise<T>): Promise<T> {
	try {
		return await write();
	} catch {
		throw new CustodySealError(what);
	}
}

// the response and both secrets live only inside this step, which returns ids; the password is
// sealed first, so a death between the seals leaves no token and the retry rolls the create back
async function firstRun(ctx: Ctx, input: SiteCreateInput, call: SiteCall): Promise<FirstRunSealed> {
	const { custody, site } = ctx.deps;
	const { reads } = call;
	return runStep(ctx, 'first-run', 'first-run', async () => {
		await fenced(ctx);
		let keptPending: string | null = null;
		if (reads !== undefined) {
			refuseSuppliedPassword(call.body, reads);
			const kept = await custody.sealed(input.site.id);
			keptPending = kept.pendingSecretId;
			const sealed =
				reads.ownerToken === undefined
					? kept.pendingSecretId !== null
					: kept.ownerTokenId !== null;
			if (sealed) return { status: null, ...kept };
		}
		const { status, secrets, admin } = await site.firstRun(input.hostname, call);
		if (status === 409 && reads?.ownerToken !== undefined) {
			return recoverClaim(ctx, input, keptPending);
		}
		const ok =
			call.expectStatus === undefined
				? status >= 200 && status < 300
				: status === call.expectStatus;
		if (!ok)
			throw new SiteCheckError(
				'the first-run call',
				status,
				String(call.expectStatus ?? '2xx')
			);
		if (reads === undefined || secrets === undefined) {
			return { status, ownerTokenId: null, pendingSecretId: null };
		}
		if (reads.ownerToken !== undefined && secrets.ownerToken === null) {
			throw new PermanentError(
				'first_run_no_owner_token',
				'the first-run response carried no owner token'
			);
		}
		const { adminPassword, ownerToken } = secrets;
		const pendingSecretId =
			adminPassword === null
				? null
				: await sealing('the admin password', () =>
						custody.sealPendingSecret(input.site.id, 'admin-password', adminPassword)
					);
		const ownerTokenId =
			ownerToken === null
				? null
				: await sealing('the owner token', () =>
						custody.sealOwnerToken(input.site.id, ownerToken)
					);
		return {
			status,
			ownerTokenId,
			pendingSecretId,
			adminName: admin?.adminName ?? null,
			adminMail: admin?.adminMail ?? null
		};
	});
}

// The claim is one-shot: the site answers 409 once an earlier call ran it. That call was ours and its
// answer was lost (the engine was stopped mid-call), since nothing else knows the hostname yet. The
// owner token comes back through the site's own KV, by writing the proof record the worker
// documents and posting its nonce. The admin password was shown once; one an earlier run sealed is
// kept, and otherwise it is gone, the operation says so, and the person resets it from the site's
// sign-in page.
async function recoverClaim(
	ctx: Ctx,
	input: SiteCreateInput,
	keptPending: string | null
): Promise<FirstRunSealed> {
	const { custody, kv, ledger, site, now } = ctx.deps;
	const row = (await ledger.live(input.site.id)).find((entry) => entry.binding === 'CONFIG_KV');
	if (row === undefined || row.providerId === null) {
		throw new PermanentError('recover_no_kv', 'the site has no CONFIG_KV to prove access with');
	}
	const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
	const key = `recover:${input.hostname}:${await sha256Hex(nonce)}`;
	await kv.put(
		row.providerId,
		key,
		JSON.stringify({ host: input.hostname, exp: now() + RECOVER_PROOF_MS })
	);
	try {
		const { status, ownerToken } = await site.recoverOwnerToken(input.hostname, nonce);
		// KV is eventually consistent, so a record that has not arrived yet is worth another try
		if (status === 404) throw new SiteCheckError('the owner token recovery', status, '200');
		if (status !== 200 || ownerToken === null) {
			throw new PermanentError(
				'recover_refused',
				`the site answered ${status} to the owner token recovery`
			);
		}
		const ownerTokenId = await sealing('the owner token', () =>
			custody.sealOwnerToken(input.site.id, ownerToken)
		);
		return { status: 409, ownerTokenId, pendingSecretId: keptPending };
	} finally {
		await kv.delete(row.providerId, key).catch(() => undefined);
	}
}

// the worker refuses a proof record more than two minutes ahead
const RECOVER_PROOF_MS = 60_000;
// the owner token is opened from custody for this one call and is not kept anywhere else
async function probeSite(
	ctx: Ctx,
	input: SiteCreateInput,
	probe: NonNullable<SiteCreateInput['probe']>,
	sealed: FirstRunSealed | null
): Promise<{ status: number }> {
	const { custody, site } = ctx.deps;
	if (probe.auth !== 'owner-token') {
		return site.probe(input.hostname, probe.path, probe.expectStatus);
	}
	if (sealed?.ownerTokenId == null) {
		throw new PermanentError(
			'probe_needs_owner_token',
			'the probe needs the owner token and none was sealed'
		);
	}
	return custody.withOwnerToken(input.site.id, sealed.ownerTokenId, (bearer) =>
		site.probe(input.hostname, probe.path, probe.expectStatus, { bearer })
	);
}

async function verify(
	ctx: Ctx,
	input: SiteCreateInput,
	sealed: FirstRunSealed | null
): Promise<void> {
	const { deps } = ctx;
	const probe = input.probe ?? { path: '/', expectStatus: 200 };
	await runStep(ctx, 'verify', 'verify', async () => {
		await fenced(ctx);
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.status === 'running'
				? transition(operation, 'verifying', deps.now())
				: operation
		);
		const { status } = await probeSite(ctx, input, probe, sealed);
		if (status !== probe.expectStatus) {
			throw new SiteCheckError('the probe', status, String(probe.expectStatus));
		}
		await deps.store.mutate(ctx.operationId, (operation) =>
			operation.verification === 'passed'
				? operation
				: setVerification(operation, 'passed', deps.now())
		);
	});
}

async function activate(
	ctx: Ctx,
	input: SiteCreateInput,
	sealed: FirstRunSealed | null
): Promise<void> {
	const { deps } = ctx;
	await runStep(ctx, 'activate', 'activate', async () => {
		await fenced(ctx);
		if (!(await deps.names.confirm(input.subdomain, input.site.id))) {
			throw new NameUnavailableError(input.subdomain, 'lost');
		}
		await deps.store.activateSite(
			{
				id: input.site.id,
				organizationId: input.site.orgId,
				name: input.site.name,
				plane: input.site.plane,
				accountId: input.site.accountId,
				category: input.site.category,
				config: input.site.config,
				releaseId: input.releaseId,
				adminName: sealed?.adminName ?? null,
				adminMail: sealed?.adminMail ?? null
			},
			deps.now()
		);
	});
}

// #endregion

// #region rollback

function rollbackActions(
	ctx: Ctx,
	input: SiteCreateInput,
	resources: ResourcePlan
): [string, () => Promise<string | void>][] {
	const { deps } = ctx;
	const siteId = input.site.id;
	const actions: [string, () => Promise<string | void>][] = [
		[
			'route',
			async () => {
				// a route this operation never reached is not ours, whoever holds the hostname now
				const operation = await deps.store.get(ctx.operationId);
				const state = operation === null ? 'pending' : stepOf(operation, 'route').state;
				if (state !== 'running' && state !== 'succeeded' && state !== 'failed') return;
				const answer = await deps.authority.deleteHostIfOwned(input.hostname, siteId);
				if (answer === 'foreign') {
					return `route for ${input.hostname} belongs to another site and was left in place`;
				}
			}
		],
		[
			'authority',
			async () => {
				const current = await deps.authority.read(siteId);
				if (current === null || current.state === 'revoked') return;
				await deps.authority.apply({
					...current,
					state: 'revoked',
					generation: current.generation + 1
				});
			}
		],
		[
			'site',
			async () => {
				if ((await deps.store.siteState(siteId)) !== null) {
					await deps.store.setSiteState(siteId, 'deleted', deps.now());
				}
			}
		],
		['custody', () => deps.custody.discard(siteId)],
		['script', () => rollbackRow(deps, claimOf(ctx, input), (row) => row.kind === 'script')]
	];
	if (input.zoneId !== undefined) {
		actions.splice(3, 0, [
			'zone-route',
			() => rollbackRow(deps, claimOf(ctx, input), (row) => row.kind === 'route')
		]);
	}
	for (const resource of resources.rollback) {
		actions.push([
			`resource.${resource.binding}`,
			() => rollbackRow(deps, claimOf(ctx, input), (row) => row.binding === resource.binding)
		]);
	}
	// whatever this operation recorded and the plan did not name still goes with it
	const planned = new Set(resources.rollback.map((resource) => resource.binding));
	actions.push([
		'recorded',
		async () => {
			const claim = claimOf(ctx, input);
			for (const row of [...(await deps.ledger.live(siteId))].reverse()) {
				const named =
					planned.has(row.binding) || row.kind === 'script' || row.kind === 'route';
				if (!named && row.createdByOperation === ctx.operationId) {
					await rollbackRow(deps, claim, (candidate) => candidate.id === row.id);
				}
			}
		}
	]);
	actions.push(['name', async () => void (await deps.names.release(input.subdomain, siteId, 0))]);
	return actions;
}

async function rollback(
	ctx: Ctx,
	input: SiteCreateInput,
	resources: ResourcePlan,
	failure: StepFailed
): Promise<Outcome> {
	const { deps } = ctx;
	const reason = describeFailure(failure);
	// the lease step may have bound an epoch and then failed before returning it
	const fence = await plainStep(ctx, 'rollback.fence', async () => {
		const epoch = ctx.epoch ?? (await deps.store.get(ctx.operationId))?.fencingEpoch ?? 0;
		if (epoch === 0) return { state: 'none' as const, epoch };
		const verdict = await deps.leases.check(input.site.id, { holder: ctx.operationId, epoch });
		if (verdict.ok) return { state: 'held' as const, epoch };
		// an expired lease nobody took is ours to take back; one a live holder has is not
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
	const closed = await closeFailed(ctx, failure);
	if (fence.state === 'none') {
		// nothing was made, but the site row the request wrote would stay behind as active
		await plainStep(ctx, 'rollback.site', async () => {
			if ((await deps.store.siteState(input.site.id)) !== null) {
				await deps.store.setSiteState(input.site.id, 'deleted', deps.now());
			}
		});
		return closed === 'cancelled'
			? { status: 'cancelled', reason }
			: { status: 'failed', reason, leaked: [] };
	}
	const actions = rollbackActions(ctx, input, resources);
	if (fence.state === 'lost') {
		return {
			status: 'failed',
			reason: `${reason}; the lease was lost, so nothing was rolled back`,
			leaked: actions.map(([name]) => name)
		};
	}

	const leaked: string[] = [];
	const notes: string[] = [];
	for (const [name, action] of actions) {
		try {
			const note = await plainStep(ctx, `rollback.${name}`, action);
			if (typeof note === 'string') notes.push(note);
		} catch (error) {
			if (!(error instanceof StepFailed)) throw error;
			leaked.push(name);
		}
	}
	const left = notes.length === 0 ? '' : `; ${notes.join('; ')}`;
	await plainStep(ctx, 'rollback.close', async () => {
		await deps.store.mutate(ctx.operationId, (operation) => {
			if (operation.status === 'rolled-back') return operation;
			return leaked.length === 0
				? transition(
						observe(operation, `rolled back after ${reason}${left}`, deps.now()),
						'rolled-back',
						deps.now()
					)
				: observe(
						operation,
						`rollback incomplete (${leaked.join(', ')}) after ${reason}${left}`,
						deps.now()
					);
		});
	});
	await releaseLease(ctx);
	return leaked.length === 0
		? { status: 'rolled-back', reason }
		: { status: 'failed', reason, leaked };
}

// #endregion

export interface StrandedCreate {
	operationId: string;
	site: Pick<SiteCreateInput['site'], 'id' | 'accountId' | 'plane' | 'config'>;
	hostname: string;
}

// finishes the rollback of a create that failed without one, as when its lease ran out and the
// failure left what it had made in place; the same actions run and the same guards hold
export async function recoverCreate(
	step: StepRunner,
	deps: EngineDeps,
	stranded: StrandedCreate
): Promise<Outcome> {
	const { site } = stranded;
	const ctx: Ctx = {
		deps,
		step,
		operationId: stranded.operationId,
		siteId: site.id,
		accountId: site.accountId,
		purpose: 'site.create',
		epoch: null
	};
	const input = {
		operationId: stranded.operationId,
		site,
		subdomain: stranded.hostname.split('.')[0],
		hostname: stranded.hostname
	} as SiteCreateInput;
	const resources = planResources(site, site.config, { database: true });
	const failure = new StepFailed('recover', new Error('recovering a create that failed'));
	return rollback(ctx, input, resources, failure);
}

export async function runSiteCreate(
	step: StepRunner,
	deps: EngineDeps,
	input: SiteCreateInput
): Promise<Outcome> {
	const ctx: Ctx = {
		deps,
		step,
		operationId: input.operationId,
		siteId: input.site.id,
		accountId: input.site.accountId,
		purpose: 'site.create',
		epoch: null
	};
	const resources = planResources(input.site, input.site.config, { database: input.database });
	let sealed: FirstRunSealed | null = null;
	try {
		await startOperation(ctx);
		await acquireLease(ctx, 'lease');
		await reserveName(ctx, input);
		for (const [index, resource] of resources.create.entries()) {
			await createResource(ctx, input, resource, index === 0 ? resources : null);
		}
		const token = await uploadAssets(ctx, input);
		await uploadScript(ctx, input, token);
		await applyAuthority(ctx, input);
		await putRoute(ctx, input);
		sealed = input.firstRun === undefined ? null : await firstRun(ctx, input, input.firstRun);
		await verify(ctx, input, sealed);
		await activate(ctx, input, sealed);
	} catch (error) {
		if (!(error instanceof StepFailed)) throw error;
		return rollback(ctx, input, resources, error);
	}
	// a failure past this point leaves a working site, so it never triggers a rollback
	const note =
		sealed?.status === 409 && sealed.pendingSecretId === null
			? '; the first admin password was lost with an answer that never arrived, so reset it from the sign-in page'
			: '';
	await finishSuccess(ctx, `${input.site.id} is active at ${input.hostname}${note}`);
	await releaseLease(ctx);
	return { status: 'succeeded' };
}
