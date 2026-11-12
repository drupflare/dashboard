import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { categoryOfKind } from '@contracts/sites';
import { newBackupId } from '../../../engine/src/backup-parts';
import { planSiteAdopt, type SiteAdoptInput } from '../../../engine/src/workflows/site-adopt';
import { ApiError } from '../../shared/errors';
import { recipeFor } from '../../shared/recipes';
import { nowUtc } from '../../shared/utils/time';
import { getUserById } from '../db/repos/identity';
import {
	createSiteOperation,
	findOpenSiteOperation,
	getOperationByKey,
	type StoredOperation
} from '../db/repos/operations';
import { getReadySite, setSiteState } from '../db/repos/sites';
import { backupServices } from './backups';
import { buildSiteCreateInput, SiteInputError } from './site-input';
import { startRecorded, type SiteServices } from './sites';

export interface AdoptSiteInput {
	orgId: string;
	siteId: string;
	userId: string;
	idempotencyKey: string;
}

// the engine owns every status after it accepts the start. The source is read and marked, never
// changed; the managed copy is a new site that the engine activates once the copy checks out
export async function adoptSite(
	services: SiteServices,
	input: AdoptSiteInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'site.adopt' ||
			known.operation.targetIds[1] !== input.siteId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const source = await getReadySite(db, input.orgId, input.siteId);
	if (source === null) throw new ApiError('not_found', 'Not found');
	if (source.plane !== 'self-managed') {
		throw new ApiError('unprocessable', 'Only a self-managed site can be adopted', {
			reason: 'not_self_managed'
		});
	}
	if (source.state !== 'active' || source.accountId === null || source.primaryHostname === null) {
		throw new ApiError('unprocessable', 'This site is not live, so it cannot be adopted', {
			reason: 'site_not_live'
		});
	}
	if (source.adoptedTo !== null) {
		throw new ApiError('conflict', 'This site was already adopted', {
			reason: 'already_adopted',
			adoptedTo: source.adoptedTo
		});
	}
	const busy = await findOpenSiteOperation(db, input.orgId, source.id);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{ reason: 'site_busy', operationId: busy.id, operation: busy.type }
		);
	}
	const decision = await services.entitlements.check({
		orgId: input.orgId,
		userId: input.userId,
		kind: source.kind
	});
	if (!decision.allow) {
		throw new ApiError('forbidden', 'Your plan has no room for another site', {
			requires: 'entitlement',
			feature: 'site.create',
			reason: 'plan_full',
			denial: decision.reason
		});
	}

	const targetId = newId('site');
	const operationId = newId('op');
	const { config } = services;
	const owner = await getUserById(db, input.userId);
	let engineInput;
	try {
		engineInput = await buildSiteCreateInput({
			site: {
				id: targetId,
				name: source.name,
				kind: source.kind,
				category: categoryOfKind(source.kind),
				plane: 'managed',
				label: undefined
			},
			organization: { id: input.orgId, planId: decision.entitlement.planId },
			operation: { id: operationId },
			recipe: recipeFor(source.kind),
			release: config.releases[source.kind],
			account: config.accountId,
			hostSuffix: config.hostSuffix,
			labelSuffix: config.labelSuffix,
			...(owner === null ? {} : { ownerEmail: owner.email })
		});
	} catch (error) {
		if (!(error instanceof SiteInputError)) throw error;
		if (error.code === 'no_account' || error.code === 'no_release') {
			throw new ApiError('not_built', error.message);
		}
		throw new ApiError('unprocessable', error.message, { reason: error.code });
	}
	// the new site's admin account is the source's, so only the owner token is kept from the first run
	const ownerToken = engineInput.firstRun?.reads?.ownerToken;
	if (engineInput.firstRun === undefined || ownerToken === undefined) {
		throw new ApiError('unprocessable', 'This kind of site cannot be adopted', {
			reason: 'unsupported_kind'
		});
	}
	const { restoreCeilingBytes, waitMs, pollMs } = backupServices();
	const params: SiteAdoptInput = {
		operationId,
		orgId: input.orgId,
		backupId: newBackupId(),
		source: { id: source.id, accountId: source.accountId },
		create: {
			...engineInput,
			firstRun: { ...engineInput.firstRun, reads: { ownerToken } }
		},
		waitMs,
		pollMs,
		restoreCeilingBytes
	};
	const plan = planSiteAdopt(params);
	const now = nowUtc().toMillis();
	const { operation, created } = await createSiteOperation(
		db,
		{
			id: targetId,
			organizationId: input.orgId,
			name: source.name,
			kind: source.kind,
			category: engineInput.site.category,
			plane: 'managed',
			config: engineInput.site.config,
			primaryHostname: engineInput.hostname,
			now
		},
		{
			id: operationId,
			organizationId: input.orgId,
			accountId: engineInput.site.accountId,
			siteId: source.id,
			type: 'site.adopt',
			status: 'planned',
			idempotencyKey: input.idempotencyKey,
			targetIds: plan.targetIds,
			preconditions: plan.preconditions,
			planDigest: await computePlanDigest(plan),
			blastRadius: plan.blastRadius,
			rollbackPoint: plan.rollbackPoint,
			verification: 'pending',
			budget: DEFAULT_CHANGE_BUDGET,
			steps: plan.steps,
			inputs: params,
			now
		}
	);
	if (!created) return operation;
	try {
		return await startRecorded(
			services,
			db,
			input.orgId,
			operation,
			{
				workflow: 'site-adopt',
				id: operationId,
				params: params as unknown as Record<string, unknown>
			},
			'The adoption could not be started'
		);
	} catch (error) {
		// the engine never took it, so the hidden copy is not kept
		await setSiteState(db, input.orgId, targetId, 'deleted', nowUtc().toMillis());
		throw error;
	}
}
