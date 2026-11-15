import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET, type Plan } from '@contracts/operations';
import { categoryOfKind } from '@contracts/sites';
import type { CollegeDBClient } from '@earth-app/collegedb';
import type { BackupRecord } from '../../../engine/src/backup-parts';
import { planBackupVerify } from '../../../engine/src/workflows/backup-verify';
import { planEnvCreate, type EnvCreateInput } from '../../../engine/src/workflows/env-create';
import { planEnvDelete, type EnvDeleteInput } from '../../../engine/src/workflows/env-delete';
import type { CopyInput } from '../../../engine/src/workflows/restored-copy';
import {
	clampPreviewTtl,
	ENVIRONMENT_KIND_LABELS,
	environmentLabel,
	freePreviewNumber,
	labelOfHost,
	previewNumberOf,
	scratchLabel,
	type EnvironmentKind
} from '../../shared/environments';
import { ApiError } from '../../shared/errors';
import { PLANS } from '../../shared/plans';
import { recipeFor } from '../../shared/recipes';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord, getBackup, listBackups } from '../db/repos/backups';
import {
	createEnvironment,
	getEnvironment,
	listEnvironments,
	listExpiredEnvironments,
	setEnvironmentStatus,
	type EnvironmentRecord
} from '../db/repos/environments';
import { getUserById } from '../db/repos/identity';
import {
	createSiteOperation,
	findOpenSiteOperation,
	getOperationByKey,
	getOperationInputs,
	type StoredOperation
} from '../db/repos/operations';
import { getOrganizationOwnerId, listDrillCandidates } from '../db/repos/restore-drills';
import { getReadySite, getSite, setSiteState, type SiteRecord } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { backupServices } from './backups';
import { buildSiteCreateInput, SiteInputError } from './site-input';
import { siteServices, startRecorded, type SiteServices } from './sites';

// a key acts for the user who issued it, so the copy's first admin mail goes to them
export const actingUserId = (principal: Principal) =>
	principal.kind === 'user' ? principal.userId : principal.issuerId;

const notFound = () => new ApiError('not_found', 'Not found');

function inputRefusal(error: unknown): never {
	if (!(error instanceof SiteInputError)) throw error;
	if (error.code === 'no_account' || error.code === 'no_release') {
		throw new ApiError('not_built', error.message);
	}
	throw new ApiError('unprocessable', error.message, { reason: error.code });
}

async function liveSite(
	services: SiteServices,
	orgId: string,
	siteId: string
): Promise<{
	db: CollegeDBClient;
	site: SiteRecord & { accountId: string; primaryHostname: string };
}> {
	const db = await services.getDb();
	const site = await getReadySite(db, orgId, siteId);
	if (site === null) throw notFound();
	if (site.state !== 'active' || site.accountId === null || site.primaryHostname === null) {
		throw new ApiError('unprocessable', 'The site is not active', {
			reason: 'site_not_active'
		});
	}
	return {
		db,
		site: { ...site, accountId: site.accountId, primaryHostname: site.primaryHostname }
	};
}

async function reused(
	db: CollegeDBClient,
	orgId: string,
	key: string,
	type: StoredOperation['operation']['type']
): Promise<StoredOperation | null> {
	const known = await getOperationByKey(db, orgId, key);
	if (known === null) return null;
	if (known.operation.type !== type) {
		throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
			reason: 'idempotency_key_reused'
		});
	}
	return known;
}

// the copy is built as a create builds it; its first run keeps the owner token only, since the
// saved copy brings the admin accounts
async function copyInputFor(
	services: SiteServices,
	db: CollegeDBClient,
	parts: {
		orgId: string;
		userId: string;
		parent: SiteRecord;
		copyId: string;
		name: string;
		label: string;
		planId: string;
		operationId: string;
		backup: BackupRecord;
		temporary: boolean;
	}
): Promise<CopyInput> {
	const { config } = services;
	const owner = await getUserById(db, parts.userId);
	const built = await buildSiteCreateInput({
		site: {
			id: parts.copyId,
			name: parts.name,
			kind: parts.parent.kind,
			category: categoryOfKind(parts.parent.kind),
			plane: 'managed',
			label: parts.label
		},
		organization: { id: parts.orgId, planId: parts.planId },
		operation: { id: parts.operationId },
		recipe: recipeFor(parts.parent.kind),
		release: parts.parent.releaseId ?? config.releases[parts.parent.kind],
		account: config.accountId,
		hostSuffix: config.hostSuffix,
		labelSuffix: config.labelSuffix,
		reservedOk: true,
		...(owner === null ? {} : { ownerEmail: owner.email })
	}).catch(inputRefusal);
	const ownerToken = built.firstRun?.reads?.ownerToken;
	if (built.firstRun === undefined || ownerToken === undefined) {
		throw new ApiError('unprocessable', 'This kind of site cannot be copied', {
			reason: 'unsupported_kind'
		});
	}
	const { restoreCeilingBytes, waitMs, pollMs } = backupServices();
	return {
		operationId: parts.operationId,
		orgId: parts.orgId,
		backupId: parts.backup.id,
		create: {
			...built,
			firstRun: { ...built.firstRun, reads: { ownerToken } },
			...(parts.temporary ? { temporary: true } : {})
		},
		waitMs,
		pollMs,
		restoreCeilingBytes
	};
}

// writes the hidden site row with the operation, so a repeat of the key writes nothing
async function recordCopy(
	services: SiteServices,
	db: CollegeDBClient,
	record: {
		parent: SiteRecord & { accountId: string };
		input: CopyInput;
		plan: Plan;
		type: 'backup.verify' | 'env.create';
		idempotencyKey: string;
		inputs: unknown;
	}
) {
	const { input, parent, plan } = record;
	const now = nowUtc().toMillis();
	return createSiteOperation(
		db,
		{
			id: input.create.site.id,
			organizationId: input.orgId,
			name: input.create.site.name,
			kind: input.create.site.kind,
			category: input.create.site.category,
			plane: 'managed',
			config: input.create.site.config,
			primaryHostname: input.create.hostname,
			now
		},
		{
			id: input.operationId,
			organizationId: input.orgId,
			accountId: input.create.site.accountId,
			siteId: parent.id,
			type: record.type,
			status: 'planned',
			idempotencyKey: record.idempotencyKey,
			targetIds: plan.targetIds,
			preconditions: plan.preconditions,
			planDigest: await computePlanDigest(plan),
			blastRadius: plan.blastRadius,
			rollbackPoint: plan.rollbackPoint,
			verification: 'pending',
			budget: DEFAULT_CHANGE_BUDGET,
			steps: plan.steps,
			inputs: record.inputs,
			now
		}
	);
}

// #region verify

export interface VerifyBackupInput {
	orgId: string;
	siteId: string;
	backupId: string;
	userId: string;
	idempotencyKey: string;
}

// the backup is restored into a scratch site that the engine removes again, so nothing live moves
export async function startVerify(input: VerifyBackupInput): Promise<StoredOperation> {
	const services = siteServices();
	const db = await services.getDb();
	const known = await reused(db, input.orgId, input.idempotencyKey, 'backup.verify');
	if (known) return known;
	const { site } = await liveSite(services, input.orgId, input.siteId);
	const backup = await getBackup(db, input.orgId, site.id, input.backupId);
	if (backup === null) throw notFound();
	const { restoreCeilingBytes } = backupServices();
	if (!backup.restorable || backup.bytes > restoreCeilingBytes) {
		throw new ApiError('unprocessable', 'This backup is too large to test restore', {
			reason: 'not_restorable',
			bytes: backup.bytes,
			limit: restoreCeilingBytes
		});
	}
	const operationId = newId('op');
	const copy = await copyInputFor(services, db, {
		orgId: input.orgId,
		userId: input.userId,
		parent: site,
		copyId: newId('site'),
		name: `${site.name} (Test Restore)`,
		label: scratchLabel(operationId),
		planId: (await services.planOf(input.orgId)).managedPlanId,
		operationId,
		backup,
		temporary: true
	});
	const plan = planBackupVerify(copy);
	const { operation, created } = await recordCopy(services, db, {
		parent: site,
		input: copy,
		plan,
		type: 'backup.verify',
		idempotencyKey: input.idempotencyKey,
		inputs: copy
	});
	if (!created) return operation;
	try {
		return await startRecorded(
			services,
			db,
			input.orgId,
			operation,
			{
				workflow: 'backup-verify',
				id: operationId,
				params: copy as unknown as Record<string, unknown>
			},
			'The test restore could not be started'
		);
	} catch (error) {
		await setSiteState(db, input.orgId, copy.create.site.id, 'deleted', nowUtc().toMillis());
		throw error;
	}
}

// #endregion

// #region environments

export interface CreateEnvironmentInput {
	orgId: string;
	siteId: string;
	kind: EnvironmentKind;
	// absent means the newest backup of the site that can be restored
	backupId?: string;
	// a preview is numbered and expires; a staging or dev copy does neither
	number?: number;
	ttlMs?: number;
	userId: string;
	idempotencyKey: string;
}

// the first plan that includes staging, so a refusal can name what unlocks it
export function planUnlockingEnvironments(): { id: string; name: string } | null {
	const plan = PLANS.find((candidate) => candidate.staging === true && !candidate.disabled);
	return plan === undefined ? null : { id: plan.id, name: plan.name };
}

export async function startEnvCreate(
	input: CreateEnvironmentInput
): Promise<{ environment: EnvironmentRecord; operation: StoredOperation }> {
	const services = siteServices();
	const db = await services.getDb();
	const entitlement = await services.planOf(input.orgId);
	if (!entitlement.environments) {
		const unlocks = planUnlockingEnvironments();
		throw new ApiError('forbidden', 'Your plan does not include staging and dev copies', {
			requires: 'entitlement',
			feature: 'environments',
			unlockedBy: unlocks
		});
	}
	const { site } = await liveSite(services, input.orgId, input.siteId);
	const known = await reused(db, input.orgId, input.idempotencyKey, 'env.create');
	if (known) {
		const recorded = (await getOperationInputs(db, input.orgId, known.operation.id)) as {
			environment?: { id: string };
		} | null;
		const existing = await getEnvironment(
			db,
			input.orgId,
			site.id,
			recorded?.environment?.id ?? ''
		);
		if (existing === null) throw notFound();
		return { environment: existing, operation: known };
	}
	const siteLabel = labelOfHost(site.primaryHostname, services.config.labelSuffix);
	let number = input.number;
	let ttlMs = input.ttlMs;
	if (input.kind === 'preview') {
		ttlMs = clampPreviewTtl(ttlMs);
		if (number === undefined) {
			const taken = (await listEnvironments(db, input.orgId, site.id))
				.filter((row) => row.kind === 'preview')
				.flatMap((row) => previewNumberOf(row.name) ?? []);
			const free = freePreviewNumber(taken);
			if (free === null) {
				throw new ApiError(
					'conflict',
					'This site already has the most previews it can hold',
					{
						reason: 'preview_limit'
					}
				);
			}
			number = free;
		}
	}
	let label: string;
	try {
		label = environmentLabel(siteLabel, input.kind, number);
	} catch {
		throw new ApiError('unprocessable', 'This site name cannot take an environment name', {
			reason: 'bad_label'
		});
	}
	const backup =
		input.backupId === undefined
			? (await listBackups(db, input.orgId, site.id, { count: 50 })).find(
					(row) => row.restorable
				)
			: await getBackup(db, input.orgId, site.id, input.backupId);
	if (backup === null || backup === undefined) {
		throw new ApiError('unprocessable', 'Take a backup of this site first', {
			reason: 'no_backup'
		});
	}
	const { restoreCeilingBytes } = backupServices();
	if (!backup.restorable || backup.bytes > restoreCeilingBytes) {
		throw new ApiError('unprocessable', 'This backup is too large to copy into a site', {
			reason: 'not_restorable'
		});
	}
	const operationId = newId('op');
	const copyId = newId('site');
	const environmentId = newId('env');
	const copy = await copyInputFor(services, db, {
		orgId: input.orgId,
		userId: input.userId,
		parent: site,
		copyId,
		name: `${site.name} (${ENVIRONMENT_KIND_LABELS[input.kind]})`,
		label,
		planId: entitlement.managedPlanId,
		operationId,
		backup,
		temporary: input.kind === 'preview'
	});
	const params: EnvCreateInput = { ...copy, environment: { id: environmentId } };
	const plan = planEnvCreate(params);
	const now = nowUtc().toMillis();
	// the host is unique among live environments, so a second create of one kind is refused here
	try {
		await createEnvironment(db, {
			id: environmentId,
			organizationId: input.orgId,
			siteId: site.id,
			kind: input.kind,
			name: label,
			host: copy.create.hostname,
			status: 'creating',
			envSiteId: copyId,
			sourceBackupId: backup.id,
			ttlAt: ttlMs === undefined ? null : now + ttlMs,
			createdAt: now
		});
	} catch {
		throw new ApiError('conflict', 'This site already has that environment', {
			reason: 'environment_exists'
		});
	}
	const { operation, created } = await recordCopy(services, db, {
		parent: site,
		input: copy,
		plan,
		type: 'env.create',
		idempotencyKey: input.idempotencyKey,
		inputs: params
	});
	const environment = (await getEnvironment(db, input.orgId, site.id, environmentId))!;
	if (!created) return { environment, operation };
	try {
		return {
			environment,
			operation: await startRecorded(
				services,
				db,
				input.orgId,
				operation,
				{
					workflow: 'env-create',
					id: operationId,
					params: params as unknown as Record<string, unknown>
				},
				'The environment could not be started'
			)
		};
	} catch (error) {
		await setSiteState(db, input.orgId, copyId, 'deleted', nowUtc().toMillis());
		await setEnvironmentStatus(db, input.orgId, site.id, environmentId, 'failed', now);
		throw error;
	}
}

export interface DeleteEnvironmentInput {
	orgId: string;
	siteId: string;
	environmentId: string;
	idempotencyKey: string;
}

// a copy that is still being made is left alone until it ends
export async function startEnvDelete(input: DeleteEnvironmentInput): Promise<StoredOperation> {
	const services = siteServices();
	const db = await services.getDb();
	const known = await reused(db, input.orgId, input.idempotencyKey, 'env.delete');
	if (known) return known;
	if ((await getReadySite(db, input.orgId, input.siteId)) === null) throw notFound();
	const environment = await getEnvironment(db, input.orgId, input.siteId, input.environmentId);
	if (environment === null || environment.envSiteId === null) throw notFound();
	if (environment.status !== 'ready' && environment.status !== 'failed') {
		throw new ApiError(
			'conflict',
			'This environment is still changing. Wait for it to finish.',
			{
				reason: 'environment_busy'
			}
		);
	}
	const copy = await getSite(db, input.orgId, environment.envSiteId);
	const busy =
		copy === null ? null : await findOpenSiteOperation(db, input.orgId, environment.envSiteId);
	if (busy) {
		throw new ApiError('conflict', 'Another change to this copy is still running.', {
			reason: 'site_busy',
			operationId: busy.id
		});
	}
	const accountId = copy?.accountId ?? services.config.accountId;
	if (accountId === null || accountId === undefined) {
		throw new ApiError('not_built', 'no managed account is configured');
	}
	const operationId = newId('op');
	const params: EnvDeleteInput = {
		operationId,
		orgId: input.orgId,
		environment: { id: environment.id },
		siteId: environment.envSiteId,
		accountId,
		plane: 'managed',
		hostname: environment.host,
		subdomain: environment.name
	};
	const plan = planEnvDelete(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId,
		siteId: input.siteId,
		type: 'env.delete',
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: plan.targetIds,
		preconditions: plan.preconditions,
		planDigest: await computePlanDigest(plan),
		blastRadius: plan.blastRadius,
		rollbackPoint: plan.rollbackPoint,
		verification: 'not-required',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: plan.steps,
		inputs: params,
		now: nowUtc().toMillis()
	});
	if (!created) return operation;
	await setEnvironmentStatus(
		db,
		input.orgId,
		input.siteId,
		environment.id,
		'deleting',
		nowUtc().toMillis()
	);
	try {
		return await startRecorded(
			services,
			db,
			input.orgId,
			operation,
			{
				workflow: 'env-delete',
				id: operationId,
				params: params as unknown as Record<string, unknown>
			},
			'The delete could not be started'
		);
	} catch (error) {
		await setEnvironmentStatus(
			db,
			input.orgId,
			input.siteId,
			environment.id,
			'failed',
			nowUtc().toMillis()
		);
		throw error;
	}
}

// #endregion

// #region restore drills

const WEEK_MS = 7 * 86_400_000;

// one drill per tick keeps the account's API budget and the scratch-site churn bounded
export const DRILLS_PER_TICK = 1;

// a site that cannot start a drill stays due, so a few failures end the tick instead of scanning on
const DRILL_MAX_FAILURES = 5;

export interface DrillSummary {
	skipped?: string;
	due: number;
	started: string[];
	failed: { siteId: string; message: string }[];
}

// the key carries the week, so a drill that is still running or has finished is not started
// again, and a drill that failed is not retried until the next week
export async function runRestoreDrills(nowMs: number): Promise<DrillSummary> {
	const services = siteServices();
	if (services.config.restoreDrills === false) {
		return { skipped: 'restore drills are off', due: 0, started: [], failed: [] };
	}
	const db = await services.getDb();
	const { restoreCeilingBytes } = backupServices();
	const due = (await listDrillCandidates(db, nowMs - WEEK_MS)).filter(
		(candidate) => candidate.bytes <= restoreCeilingBytes
	);
	const summary: DrillSummary = { due: due.length, started: [], failed: [] };
	for (const candidate of due) {
		if (
			summary.started.length >= DRILLS_PER_TICK ||
			summary.failed.length >= DRILL_MAX_FAILURES
		) {
			break;
		}
		try {
			const userId = await getOrganizationOwnerId(db, candidate.organizationId);
			if (userId === null) throw new Error('the organization has no owner');
			await startVerify({
				orgId: candidate.organizationId,
				siteId: candidate.siteId,
				backupId: candidate.backupId,
				userId,
				idempotencyKey: `drill:${candidate.siteId}:${Math.floor(nowMs / WEEK_MS)}`
			});
			summary.started.push(candidate.siteId);
		} catch (error) {
			summary.failed.push({
				siteId: candidate.siteId,
				message: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return summary;
}

// #endregion

// #region ttl sweep

const DAY_MS = 86_400_000;

export interface SweepSummary {
	expired: number;
	started: string[];
	failed: { environmentId: string; message: string }[];
}

// a delete that fails is tried again on the next tick, and a new attempt after a failed one starts
// on the next day, because the key carries the day
export async function sweepExpiredEnvironments(nowMs: number): Promise<SweepSummary> {
	const db = await siteServices().getDb();
	const expired = await listExpiredEnvironments(db, nowMs);
	const summary: SweepSummary = { expired: expired.length, started: [], failed: [] };
	for (const environment of expired) {
		try {
			await startEnvDelete({
				orgId: environment.organizationId,
				siteId: environment.siteId,
				environmentId: environment.id,
				idempotencyKey: `ttl:${environment.id}:${Math.floor(nowMs / DAY_MS)}`
			});
			summary.started.push(environment.id);
		} catch (error) {
			summary.failed.push({
				environmentId: environment.id,
				message: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return summary;
}

// #endregion
