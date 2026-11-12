import { newId } from '@contracts/common';
import {
	DEFAULT_CHANGE_BUDGET,
	computePlanDigest,
	type Operation,
	type OperationType,
	type Plan
} from '@contracts/operations';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { newBackupId } from '../../../engine/src/backup-parts';
import {
	planBackupCreate,
	type BackupCreateInput
} from '../../../engine/src/workflows/backup-create';
import {
	planBackupRestore,
	type BackupRestoreInput
} from '../../../engine/src/workflows/backup-restore';
import type { CleanupTarget } from '../../../engine/src/workflows/site-cleanup';
import type { SiteCreateInput } from '../../../engine/src/workflows/site-create';
import { planSiteUpgrade, type SiteUpgradeInput } from '../../../engine/src/workflows/site-upgrade';
import { ApiError } from '../../shared/errors';
import type { Action } from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { BatchFailedError } from '../db/repos/accounts';
import { createOperationRecord } from '../db/repos/backups';
import {
	findOpenSiteOperation,
	getOperation,
	getOperationByKey,
	getOperationInputs,
	listRetriesOf,
	type StoredOperation
} from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import { OPEN_OPERATION_STATUSES } from '../db/schema';
import {
	cleanupSite,
	entitlementRefusal,
	recordAndStartCreate,
	startRecorded,
	type SiteServices
} from './sites';

// the permission a person needs to start the same operation fresh; a retry asks for it again
export const RETRY_ACTIONS: Partial<Record<OperationType, Action>> = {
	'site.create': 'site.create',
	'site.upgrade': 'site.upgrade',
	'backup.create': 'site.backup',
	'backup.restore': 'site.restore',
	'repair.run': 'site.cleanup'
};

// a create and a backup undo themselves when they fail, so the failure ends as rolled-back
const ROLLS_BACK: readonly OperationType[] = ['site.create', 'backup.create'];

const NOT_RETRYABLE: Partial<Record<OperationType, string>> = {
	'site.delete':
		'A delete asks you to type the site name again. Start it again from the site settings; the new run finishes whatever the first one left.',
	'site.purge': 'A purge is started by the platform and is not retried here.'
};
const NOT_RETRYABLE_DEFAULT =
	'This kind of operation cannot be retried. Start it again from the page where you began it.';

const isOpen = (status: Operation['status']) =>
	(OPEN_OPERATION_STATUSES as readonly string[]).includes(status);

export interface RetryInput {
	orgId: string;
	operationId: string;
	userId: string;
	idempotencyKey: string;
	// throws when the caller may not start this type of operation on this site
	allow: (type: OperationType, siteId: string | undefined) => void;
}

interface Spec {
	type: 'site.upgrade' | 'backup.create' | 'backup.restore';
	siteId: string;
	accountId: string;
	plan: Plan;
	verification: Operation['verification'];
	workflow: 'site-upgrade' | 'backup-create' | 'backup-restore';
	params: SiteUpgradeInput | BackupCreateInput | BackupRestoreInput;
	refusal: string;
}

async function recordRetry(
	services: SiteServices,
	db: CollegeDBClient,
	input: RetryInput,
	spec: Spec
): Promise<StoredOperation> {
	const { operationId } = spec.params;
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: spec.accountId,
		siteId: spec.siteId,
		type: spec.type,
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: spec.plan.targetIds,
		preconditions: spec.plan.preconditions,
		planDigest: await computePlanDigest(spec.plan),
		blastRadius: spec.plan.blastRadius,
		rollbackPoint: spec.plan.rollbackPoint,
		verification: spec.verification,
		budget: DEFAULT_CHANGE_BUDGET,
		steps: spec.plan.steps,
		retryOf: input.operationId,
		inputs: spec.params,
		now: nowUtc().toMillis()
	});
	if (!created) return operation;
	return startRecorded(
		services,
		db,
		input.orgId,
		operation,
		{
			workflow: spec.workflow,
			id: operationId,
			params: spec.params as unknown as Record<string, unknown>
		},
		spec.refusal
	);
}

async function liveSiteOf(db: CollegeDBClient, orgId: string, siteId: string) {
	const site = await getReadySite(db, orgId, siteId);
	if (
		site === null ||
		site.state !== 'active' ||
		site.accountId === null ||
		site.primaryHostname === null
	) {
		throw new ApiError(
			'unprocessable',
			'This site is not live, so the work cannot be retried',
			{
				reason: 'site_not_live'
			}
		);
	}
	const busy = await findOpenSiteOperation(db, orgId, siteId);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{ reason: 'site_busy', operationId: busy.id, operation: busy.type }
		);
	}
	return { ...site, accountId: site.accountId, primaryHostname: site.primaryHostname };
}

// the earlier site is cleaned up by the new create's first step. When that step is what failed,
// the earlier site is still the one with leftovers, and the failed create's own site made nothing
function priorOf(failed: Operation, inputs: SiteCreateInput): CleanupTarget {
	const cleanup = failed.steps.find((step) => step.id === 'cleanup');
	if (inputs.prior !== undefined && cleanup !== undefined && cleanup.state !== 'succeeded') {
		return inputs.prior;
	}
	return {
		siteId: inputs.site.id,
		accountId: inputs.site.accountId,
		plane: inputs.site.plane,
		hostname: inputs.hostname,
		subdomain: inputs.subdomain
	};
}

async function retryCreate(
	services: SiteServices,
	input: RetryInput,
	failed: Operation,
	inputs: SiteCreateInput
): Promise<StoredOperation> {
	const decision = await services.entitlements.check({
		orgId: input.orgId,
		userId: input.userId,
		kind: inputs.site.kind
	});
	if (!decision.allow) throw entitlementRefusal(decision.reason);
	const engineInput: SiteCreateInput = {
		...inputs,
		operationId: newId('op'),
		site: { ...inputs.site, id: newId('site') },
		prior: priorOf(failed, inputs)
	};
	return recordAndStartCreate(services, engineInput, {
		orgId: input.orgId,
		idempotencyKey: input.idempotencyKey,
		retryOf: failed.id
	});
}

async function retryUpgrade(
	services: SiteServices,
	db: CollegeDBClient,
	input: RetryInput,
	failed: Operation,
	inputs: SiteUpgradeInput
): Promise<StoredOperation> {
	const site = await liveSiteOf(db, input.orgId, failed.targetIds[0] ?? '');
	if (site.releaseId === inputs.releaseId) {
		throw new ApiError('conflict', 'This site already runs that release', {
			reason: 'up_to_date',
			release: inputs.releaseId
		});
	}
	const params: SiteUpgradeInput = {
		...inputs,
		operationId: newId('op'),
		currentRelease: site.releaseId
	};
	return recordRetry(services, db, input, {
		type: 'site.upgrade',
		siteId: site.id,
		accountId: site.accountId,
		plan: planSiteUpgrade(params),
		verification: 'pending',
		workflow: 'site-upgrade',
		params,
		refusal: 'The update could not be started'
	});
}

async function retryBackup(
	services: SiteServices,
	db: CollegeDBClient,
	input: RetryInput,
	failed: Operation,
	inputs: BackupCreateInput
): Promise<StoredOperation> {
	const site = await liveSiteOf(db, input.orgId, failed.targetIds[0] ?? '');
	const params: BackupCreateInput = {
		...inputs,
		operationId: newId('op'),
		backupId: newBackupId(),
		accountId: site.accountId
	};
	return recordRetry(services, db, input, {
		type: 'backup.create',
		siteId: site.id,
		accountId: site.accountId,
		plan: planBackupCreate(params),
		verification: 'pending',
		workflow: 'backup-create',
		params,
		refusal: 'The backup could not be started'
	});
}

// a restore overwrites the database and is finished by running it again, so the same backup goes
// to the same site under a new operation
async function retryRestore(
	services: SiteServices,
	db: CollegeDBClient,
	input: RetryInput,
	failed: Operation,
	inputs: BackupRestoreInput
): Promise<StoredOperation> {
	const site = await liveSiteOf(db, input.orgId, failed.targetIds[0] ?? '');
	const params: BackupRestoreInput = {
		...inputs,
		operationId: newId('op'),
		accountId: site.accountId
	};
	return recordRetry(services, db, input, {
		type: 'backup.restore',
		siteId: site.id,
		accountId: site.accountId,
		plan: planBackupRestore(params),
		verification: 'pending',
		workflow: 'backup-restore',
		params,
		refusal: 'The restore could not be started'
	});
}

// starts the same work again as a new operation that points back at the failed one. A retry that
// is running or has succeeded is returned as it is, so a second press never starts a third
export async function retryOperation(
	services: SiteServices,
	input: RetryInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (known.operation.retryOf !== input.operationId) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const stored = await getOperation(db, input.orgId, input.operationId);
	if (stored === null) throw new ApiError('not_found', 'Not found');
	const failed = stored.operation;
	const { type, status } = failed;
	if (RETRY_ACTIONS[type] === undefined) {
		throw new ApiError('unprocessable', NOT_RETRYABLE[type] ?? NOT_RETRYABLE_DEFAULT, {
			reason: 'not_retryable',
			type
		});
	}
	input.allow(type, failed.targetIds[0]);
	const retryable =
		status === 'failed' || (status === 'rolled-back' && ROLLS_BACK.includes(type));
	if (!retryable) {
		throw new ApiError(
			'conflict',
			isOpen(status)
				? 'This operation is still running.'
				: 'Only an operation that failed can be retried.',
			{ reason: 'not_failed', status }
		);
	}
	const earlier = (await listRetriesOf(db, input.orgId, failed.id)).find(
		(row) => isOpen(row.operation.status) || row.operation.status === 'succeeded'
	);
	if (earlier) return earlier;
	const inputs = await getOperationInputs(db, input.orgId, failed.id);
	if (inputs === null) {
		throw new ApiError(
			'unprocessable',
			'This operation was recorded before it could be retried. Start it again from the page where you began it.',
			{ reason: 'inputs_missing' }
		);
	}

	try {
		switch (type) {
			case 'site.create':
				return await retryCreate(services, input, failed, inputs as SiteCreateInput);
			case 'site.upgrade':
				return await retryUpgrade(services, db, input, failed, inputs as SiteUpgradeInput);
			case 'backup.create':
				return await retryBackup(services, db, input, failed, inputs as BackupCreateInput);
			case 'backup.restore':
				return await retryRestore(
					services,
					db,
					input,
					failed,
					inputs as BackupRestoreInput
				);
			default:
				return await cleanupSite(services, {
					orgId: input.orgId,
					siteId: failed.targetIds[0] ?? '',
					idempotencyKey: input.idempotencyKey,
					retryOf: failed.id
				});
		}
	} catch (error) {
		// a retry that began between the check and the write won the open slot for this operation
		if (error instanceof BatchFailedError) {
			const winner = (await listRetriesOf(db, input.orgId, failed.id)).find((row) =>
				isOpen(row.operation.status)
			);
			if (winner) return winner;
		}
		throw error;
	}
}
