import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { planSiteRepair, type SiteRepairInput } from '../../../engine/src/workflows/site-repair';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import {
	findOpenSiteOperation,
	getOperationByKey,
	getOperationInputs,
	type StoredOperation
} from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import { startRecorded, type SiteServices } from './sites';

export type StartRepair = Pick<
	SiteRepairInput,
	'orgId' | 'siteId' | 'repairId' | 'trigger' | 'rung' | 'undoOf'
> & { key: string };

// the engine owns every status after it accepts the start. A key already used returns the
// operation it made, so a second tick in the same window never starts another repair
export async function startSiteRepair(
	services: SiteServices,
	input: StartRepair
): Promise<StoredOperation> {
	const db = await services.getDb();
	const { orgId } = input;
	const known = await getOperationByKey(db, orgId, input.key);
	if (known) {
		const inputs = (await getOperationInputs(
			db,
			orgId,
			known.operation.id
		)) as Partial<SiteRepairInput> | null;
		if (
			known.operation.type !== 'site.repair' ||
			inputs?.siteId !== input.siteId ||
			inputs?.repairId !== input.repairId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const site = await getReadySite(db, orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.state !== 'active' || site.accountId === null || site.primaryHostname === null) {
		throw new ApiError('unprocessable', 'This site is not live, so nothing can be repaired', {
			reason: 'site_not_live'
		});
	}
	const busy = await findOpenSiteOperation(db, orgId, site.id);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{ reason: 'site_busy', operationId: busy.id, operation: busy.type }
		);
	}
	const params: SiteRepairInput = {
		operationId: newId('op'),
		orgId,
		siteId: site.id,
		accountId: site.accountId,
		repairId: input.repairId,
		trigger: input.trigger,
		rung: input.rung,
		undoOf: input.undoOf
	};
	const plan = planSiteRepair(params);
	const { operation, created } = await createOperationRecord(db, {
		id: params.operationId,
		organizationId: orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'site.repair',
		status: 'planned',
		idempotencyKey: input.key,
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
		orgId,
		operation,
		{
			workflow: 'site-repair',
			id: params.operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The repair could not be started. Try again in a few minutes.'
	);
}
