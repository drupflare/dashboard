import { newId } from '@contracts/common';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest } from '@contracts/operations';
import {
	planSiteRollback,
	type SiteRollbackInput
} from '../../../engine/src/workflows/site-rollback';
import { ApiError } from '../../shared/errors';
import { recipeFor, type Recipe } from '../../shared/recipes';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import {
	findOpenSiteOperation,
	getOperationByKey,
	type StoredOperation
} from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import { checkRollback } from './rollback-check';
import { startRecorded, type SiteServices } from './sites';

// a bundle names no health path, so the front page is what a custom site's check reads
const CUSTOM_PROBE: Pick<Recipe, 'probe'> = {
	probe: {
		method: 'GET',
		path: '/',
		provenance: { unverified: true, confirm: 'a bundle names no health path' }
	}
};

export interface RollbackSiteInput {
	orgId: string;
	siteId: string;
	release: string;
	idempotencyKey: string;
}

// the guard runs here for the answer and again in the engine for the record; the engine's answer wins
export async function rollbackSite(
	services: SiteServices,
	input: RollbackSiteInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'site.rollback' ||
			known.operation.targetIds[0] !== input.siteId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (
		site.state !== 'active' ||
		(site.plane !== 'managed' && site.plane !== 'self-managed') ||
		site.accountId === null ||
		site.primaryHostname === null
	) {
		throw new ApiError('unprocessable', 'This site is not live, so it cannot be rolled back', {
			reason: 'site_not_live'
		});
	}
	if (site.releaseId === input.release) {
		throw new ApiError('conflict', 'This site already runs that release', {
			reason: 'up_to_date',
			release: input.release
		});
	}
	const verdict = await checkRollback(services, input);
	if (!verdict.allowed) {
		throw new ApiError('unprocessable', verdict.reason ?? 'The rollback is not safe', {
			reason: 'rollback_refused',
			offers: verdict.offers
		});
	}
	const recipe: Pick<Recipe, 'probe'> | undefined =
		site.kind === 'custom' ? CUSTOM_PROBE : recipeFor(site.kind);
	if (recipe === undefined) {
		throw new ApiError('unprocessable', `There is no recipe for ${site.kind}`, {
			reason: 'no_recipe'
		});
	}
	const busy = await findOpenSiteOperation(db, input.orgId, site.id);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{ reason: 'site_busy', operationId: busy.id, operation: busy.type }
		);
	}

	const operationId = newId('op');
	const params: SiteRollbackInput = {
		operationId,
		site: {
			id: site.id,
			orgId: input.orgId,
			kind: site.kind,
			plane: site.plane,
			config: site.config,
			ring: 'R0',
			plan: (await services.planOf(input.orgId)).managedPlanId,
			accountId: site.accountId
		},
		hostname: site.primaryHostname,
		releaseId: input.release,
		currentRelease: site.releaseId,
		probe: {
			path: recipe.probe.path,
			expectStatus: 200,
			...(recipe.probe.auth === undefined ? {} : { auth: recipe.probe.auth })
		}
	};
	const plan = planSiteRollback(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'site.rollback',
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
		now: nowUtc().toMillis()
	});
	if (!created) return operation;
	return startRecorded(
		services,
		db,
		input.orgId,
		operation,
		{
			workflow: 'site-rollback',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The rollback could not be started'
	);
}
