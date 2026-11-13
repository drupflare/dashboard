import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { z } from 'zod';
import {
	planDomainAttach,
	type DomainAttachInput
} from '../../../engine/src/workflows/domain-attach';
import { checkHostname } from '../../shared/domain-copy';
import { ApiError } from '../../shared/errors';
import { failureReason } from '../../shared/operation-copy';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import { listAttachedDomains } from '../db/repos/custom-domains';
import {
	findOpenSiteOperation,
	getOperationByKey,
	getOperationInputs,
	listOperationsForSite,
	type StoredOperation
} from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import {
	attachViewSchema,
	DEFAULT_WAIT_MS,
	readAttachState,
	startState,
	viewOf,
	type AttachView
} from '../domain/domain-attach';
import { startRecorded, type SiteServices } from './sites';

export const domainAttachBody = z.strictObject({
	hostname: z.string().min(3).max(253)
});

export const domainPlanSchema = z.object({
	// whether this site can take a domain, which only a live managed site can
	ready: z.boolean(),
	attached: z.array(z.object({ hostname: z.string(), since: z.int().nonnegative() })),
	attach: attachViewSchema.nullable()
});

export type DomainPlan = z.infer<typeof domainPlanSchema>;

async function liveSite(services: SiteServices, orgId: string, siteId: string) {
	const db = await services.getDb();
	const site = await getReadySite(db, orgId, siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const ready = site.plane === 'managed' && site.state === 'active' && site.accountId !== null;
	return { db, site, ready };
}

async function viewOfOperation(
	db: Awaited<ReturnType<SiteServices['getDb']>>,
	orgId: string,
	stored: StoredOperation
): Promise<AttachView | null> {
	const { operation } = stored;
	let state = readAttachState(operation.cursor);
	if (state === null) {
		const inputs = (await getOperationInputs(
			db,
			orgId,
			operation.id
		)) as Partial<DomainAttachInput> | null;
		if (typeof inputs?.hostname !== 'string') return null;
		state = startState(inputs.hostname, Date.parse(operation.createdAt));
	}
	const view = viewOf(operation.id, state);
	const closed = ['failed', 'cancelled', 'rolled-back'].includes(operation.status);
	if (closed && view.status !== 'failed') {
		// the workflow ended without writing a reason, so the plain one comes from the failed step
		const failed = operation.steps.find((step) => step.state === 'failed');
		return {
			...view,
			status: 'failed',
			reason:
				failureReason({
					type: operation.type,
					status: operation.status,
					failedStep: failed?.id ?? null,
					failedError: failed?.error ?? null
				}) ?? 'Stopped before it could finish.'
		};
	}
	return view;
}

// the state of the latest attach on the site and the domains that serve it now
export async function readDomain(
	services: SiteServices,
	input: { orgId: string; siteId: string }
): Promise<DomainPlan> {
	const { db, ready } = await liveSite(services, input.orgId, input.siteId);
	const rows = await listOperationsForSite(db, input.orgId, input.siteId, { count: 50 });
	const latest = rows.find((row) => row.operation.type === 'domain.attach') ?? null;
	return {
		ready,
		attached: await listAttachedDomains(db, input.orgId, input.siteId),
		attach: latest === null ? null : await viewOfOperation(db, input.orgId, latest)
	};
}

export interface StartDomainAttachInput {
	orgId: string;
	siteId: string;
	hostname: string;
	idempotencyKey: string;
}

// the engine owns every status after it accepts the start, and the claim on the hostname is decided
// there, so a hostname another site holds is refused without saying whose it is
export async function startDomainAttach(
	services: SiteServices,
	input: StartDomainAttachInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		const inputs = (await getOperationInputs(
			db,
			input.orgId,
			known.operation.id
		)) as Partial<DomainAttachInput> | null;
		const same =
			known.operation.type === 'domain.attach' &&
			known.operation.targetIds[0] === input.siteId &&
			inputs?.hostname === checkedName(input.hostname);
		if (!same) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const hostname = checkedName(input.hostname);
	const { site, ready } = await liveSite(services, input.orgId, input.siteId);
	if (!ready || site.accountId === null) {
		throw new ApiError('unprocessable', 'This site is not live, so it cannot take a domain', {
			reason: 'site_not_live'
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
	const params: DomainAttachInput = {
		operationId: newId('op'),
		orgId: input.orgId,
		siteId: site.id,
		accountId: site.accountId,
		hostname,
		waitMs: DEFAULT_WAIT_MS
	};
	const plan = planDomainAttach(params);
	const { operation, created } = await createOperationRecord(db, {
		id: params.operationId,
		organizationId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'domain.attach',
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
			workflow: 'domain-attach',
			id: params.operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The domain could not be attached. Press Attach Domain to try again.'
	);
}

function checkedName(raw: string): string {
	const checked = checkHostname(raw);
	if (!checked.ok) {
		throw new ApiError('unprocessable', checked.message, { reason: checked.code });
	}
	return checked.hostname;
}
