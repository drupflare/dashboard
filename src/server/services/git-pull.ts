import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { planGitPull, type GitPullInput } from '../../../engine/src/workflows/git-pull';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import {
	findOpenSiteOperation,
	getOperationByKey,
	getOperationInputs,
	type StoredOperation
} from '../db/repos/operations';
import type { RemoteRow } from '../db/repos/repo-connections';
import { getReadySite } from '../db/repos/sites';
import { startRecorded, type SiteServices } from './sites';

// the engine owns every status after it accepts the start. A key already used for this repository
// returns the operation it made, so a redelivery or a second press never starts another pull
export async function startGitPull(
	services: SiteServices,
	remote: RemoteRow,
	key: string
): Promise<StoredOperation> {
	const db = await services.getDb();
	const orgId = remote.organizationId;
	const known = await getOperationByKey(db, orgId, key);
	if (known) {
		const inputs = (await getOperationInputs(
			db,
			orgId,
			known.operation.id
		)) as Partial<GitPullInput> | null;
		if (known.operation.type !== 'git.pull' || inputs?.remoteId !== remote.id) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const site = await getReadySite(db, orgId, remote.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.state !== 'active' || site.accountId === null || site.primaryHostname === null) {
		throw new ApiError('unprocessable', 'This site is not live, so nothing can be pulled', {
			reason: 'site_not_live'
		});
	}
	const busy = await findOpenSiteOperation(db, orgId, site.id);
	if (busy) {
		const busyInputs = (await getOperationInputs(db, orgId, busy.id)) as {
			remoteId?: unknown;
		} | null;
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{
				reason: 'site_busy',
				operationId: busy.id,
				operation: busy.type,
				remoteId: busyInputs?.remoteId ?? null
			}
		);
	}
	const params: GitPullInput = {
		operationId: newId('op'),
		orgId,
		siteId: site.id,
		accountId: site.accountId,
		remoteId: remote.id
	};
	const plan = planGitPull(params);
	const { operation, created } = await createOperationRecord(db, {
		id: params.operationId,
		organizationId: orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'git.pull',
		status: 'planned',
		idempotencyKey: key,
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
			workflow: 'git-pull',
			id: params.operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The pull could not be started. Press Pull to try again.'
	);
}
