import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { planSitePitr, type SitePitrInput } from '../../../engine/src/workflows/site-pitr';
import { ApiError } from '../../shared/errors';
import { PITR_WINDOW_DAYS } from '../../shared/restore-points';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import { getOperationByKey, type StoredOperation } from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import { siteServices, startRecorded } from './sites';

const DAY_MS = 86_400_000;

export interface StartPitrInput {
	orgId: string;
	siteId: string;
	// the moment to go back to, in epoch milliseconds
	at: number;
	idempotencyKey: string;
}

// the worker applies the restore the next time the site starts, so this only schedules it
export async function startPitr(input: StartPitrInput): Promise<StoredOperation> {
	const services = siteServices();
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (known.operation.type !== 'site.restore') {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.state !== 'active' || site.accountId === null) {
		throw new ApiError('unprocessable', 'The site is not active', {
			reason: 'site_not_active'
		});
	}
	const now = nowUtc().toMillis();
	if (input.at >= now || input.at < now - PITR_WINDOW_DAYS * DAY_MS) {
		throw new ApiError(
			'unprocessable',
			`Pick a moment in the last ${PITR_WINDOW_DAYS} days that has already passed`,
			{ reason: 'outside_window', windowDays: PITR_WINDOW_DAYS }
		);
	}
	const operationId = newId('op');
	const params: SitePitrInput = {
		operationId,
		orgId: input.orgId,
		siteId: site.id,
		accountId: site.accountId,
		at: input.at
	};
	const plan = planSitePitr(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'site.restore',
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
		now
	});
	if (!created) return operation;
	return startRecorded(
		services,
		db,
		input.orgId,
		operation,
		{
			workflow: 'site-pitr',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The restore could not be scheduled'
	);
}
