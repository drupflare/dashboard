import { newId } from '@contracts/common';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest, type Operation } from '@contracts/operations';
import type { Site } from '@contracts/sites';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { buildPlan } from '../../../engine/src/operations/state';
import { BOX_SITE_ELSEWHERE, BOX_SITE_REMOVE_STEP } from '../../shared/box-sites';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import {
	findOpenSiteOperation,
	getOperation,
	updateOperationStatus,
	type StoredOperation
} from '../db/repos/operations';
import {
	dropBoxSite,
	getReadySite,
	renameFoundSite,
	siteNameTaken,
	toSite,
	type SiteRecord
} from '../db/repos/sites';

const LIVE: readonly Site['state'][] = ['active', 'suspended'];
const NAME_LIMIT = 100;
const CONTROL = /[\u0000-\u001f\u007f]/;

export interface RemoveBoxSiteInput {
	orgId: string;
	confirm: string;
	idempotencyKey: string;
}

// a site on a box is only a row here, so removing it never reaches the box, and a site the box
// still reports and the dashboard made is not removed. The operation exists so the page that
// follows a delete has something to show; it ends before it returns
export async function removeBoxSite(
	db: CollegeDBClient,
	site: SiteRecord,
	input: RemoveBoxSiteInput
): Promise<StoredOperation> {
	if (site.boxFoundAs === null && site.boxMissingSince === null) {
		throw new ApiError('unprocessable', BOX_SITE_ELSEWHERE, { reason: 'box_site' });
	}
	if (!LIVE.includes(site.state)) {
		throw new ApiError('unprocessable', 'This site is already deleted', {
			reason: 'site_not_live'
		});
	}
	if (input.confirm !== site.name) {
		throw new ApiError('unprocessable', 'The name you typed does not match this site', {
			reason: 'confirm_mismatch'
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
	const plan = buildPlan({
		type: 'site.delete',
		targetIds: [site.id],
		preconditions: [`${site.id} is a listed site on a box`],
		steps: [{ id: BOX_SITE_REMOVE_STEP, name: 'Remove the site from your list' }]
	});
	const now = nowUtc().toMillis();
	const { operation, created } = await createOperationRecord(db, {
		id: newId('op'),
		organizationId: input.orgId,
		accountId: null,
		siteId: site.id,
		type: 'site.delete',
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
		now
	});
	if (!created) return operation;
	const dropped = await dropBoxSite(db, input.orgId, site.id, now);
	const status: Operation['status'] = dropped ? 'succeeded' : 'failed';
	await db.run(
		input.orgId,
		`UPDATE operation_steps SET state = ?, attempt = 1, started_at = ?, finished_at = ?
		 WHERE operation_id = ?`,
		[dropped ? 'succeeded' : 'failed', now, now, operation.operation.id]
	);
	await updateOperationStatus(
		db,
		input.orgId,
		operation.operation.id,
		operation.version,
		status,
		now
	);
	if (!dropped) {
		throw new ApiError('unprocessable', 'This site is already deleted', {
			reason: 'site_not_live'
		});
	}
	const latest = await getOperation(db, input.orgId, operation.operation.id);
	if (!latest) throw new Error(`operation ${operation.operation.id} is missing after its end`);
	return latest;
}

export interface RenameBoxSiteInput {
	orgId: string;
	siteId: string;
	name: string;
}

export async function renameBoxSite(db: CollegeDBClient, input: RenameBoxSiteInput): Promise<Site> {
	const name = input.name.trim();
	if (name === '' || name.length > NAME_LIMIT || CONTROL.test(name)) {
		throw new ApiError('validation', 'Use 1 to 100 characters for the name');
	}
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.boxFoundAs === null || !LIVE.includes(site.state)) {
		throw new ApiError('unprocessable', 'Only a site found on your box can be renamed here', {
			reason: 'not_renamable'
		});
	}
	if (await siteNameTaken(db, input.orgId, name, site.id)) {
		throw new ApiError('conflict', 'Another site already has this name', {
			reason: 'name_taken'
		});
	}
	const now = nowUtc().toMillis();
	if (!(await renameFoundSite(db, input.orgId, site.id, name, now))) {
		throw new ApiError('unprocessable', 'Only a site found on your box can be renamed here', {
			reason: 'not_renamable'
		});
	}
	return toSite({ ...site, name, updatedAt: now });
}
