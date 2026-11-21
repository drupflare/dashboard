import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	planSiteTransfer,
	type SiteTransferInput
} from '../../../engine/src/workflows/site-transfer';
import type { TransferCreate, TransferList, TransferView } from '../../shared/agency';
import { ApiError } from '../../shared/errors';
import { DuplicateRowError } from '../db/collegedb';
import {
	findDelegationBatch,
	findTransfer,
	insertTransfer,
	latestTransferRun,
	listTransfersIn,
	listTransfersOut,
	saveTransferState,
	transferHostnameCollisions,
	transferRunKey,
	type TransferRun
} from '../db/repos/agency';
import { createOperationRecord } from '../db/repos/backups';
import { findOpenSiteOperation, updateOperationStatus } from '../db/repos/operations';
import { getOrganization } from '../db/repos/organization';
import { getSiteClassification, loadPolicyForIncoming, refuseBlock } from '../db/repos/policies';
import { countOrganizationSites, getSite } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { checkTemplate, evaluatePolicy } from '../domain/policy';
import {
	acceptTransfer,
	cancelTransfer,
	completeTransfer,
	declineTransfer,
	proposeTransfer,
	transferView,
	type Transfer,
	type TransferError
} from '../domain/transfer';
import type { EngineStartRequest } from '../integrations/engine';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';

export interface TransferServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	now: () => number;
	// the receiving organisation's site limit, read before an accept; absent until the plan reads are wired
	targetLimits?: (orgId: string) => Promise<{ siteLimit: number | null }>;
	// starts the engine workflow that hands the site over; absent until the engine is wired
	startCompletion?: (request: EngineStartRequest) => Promise<void>;
}

let installed: TransferServices | null = null;

export function setTransferServices(services: TransferServices | null): void {
	installed = services;
}

export function transferServices(): TransferServices {
	if (installed === null) throw new ApiError('not_built', 'Site transfers are not available yet');
	return installed;
}

export interface TransferActor {
	principal: Principal;
	userId: string;
}

const GONE_SITE_STATES = ['tombstoned', 'purge-eligible', 'deleted'];

function mapError(reason: TransferError): ApiError {
	switch (reason) {
		case 'same_org':
			return new ApiError(
				'unprocessable',
				'Choose a different organisation to receive the site',
				{
					reason
				}
			);
		case 'not_proposed':
			return new ApiError('conflict', 'This transfer has already been answered', { reason });
		case 'not_accepted':
			return new ApiError('conflict', 'Only an accepted transfer can be completed', {
				reason
			});
		case 'expired':
			return new ApiError('conflict', 'This transfer has expired. Propose it again.', {
				reason
			});
		case 'wrong_side':
			return new ApiError('forbidden', 'This side of the transfer cannot do that', {
				reason
			});
		case 'not_party':
			return new ApiError('not_found', 'Not found');
	}
}

const OPEN_RUN = ['planned', 'awaiting-approval', 'running', 'verifying'];

const FAILURE_TEXT: [string, string][] = [
	[
		'read_back_mismatch',
		'The copy did not match the original, so nothing was removed from the sending organization. Start the handover again.'
	],
	[
		'hostname_collision',
		'The receiving organization already holds one of the domains of this site for another site.'
	],
	['site_busy', 'Another change to this site was running. Start the handover again when it ends.']
];

function failureReason(run: TransferRun): string {
	const found = FAILURE_TEXT.find(([code]) => run.summary?.includes(code));
	return found ? found[1] : 'The handover stopped before it finished. Start it again.';
}

function view(t: Transfer, now: number, run: TransferRun | null = null): TransferView {
	let state: TransferView['state'] = transferView(t, now);
	let reason: string | null = null;
	if (state === 'accepted' && run !== null) {
		if (OPEN_RUN.includes(run.status)) state = 'completing';
		else if (run.status !== 'succeeded') {
			state = 'failed';
			reason = failureReason(run);
		}
	}
	return {
		id: t.id,
		siteId: t.siteId,
		fromOrganizationId: t.fromOrgId,
		toOrganizationId: t.toOrgId,
		operationId: run?.id ?? null,
		failureReason: reason,
		state,
		keepDelegationId: t.keepDelegationId,
		proposedAt: new Date(t.proposedAt).toISOString(),
		expiresAt: new Date(t.expiresAt).toISOString(),
		decidedAt: t.decidedAt === null ? null : new Date(t.decidedAt).toISOString()
	};
}

async function auditBoth(
	deps: TransferServices,
	t: Transfer,
	actor: TransferActor,
	action: string,
	detail: Record<string, unknown>
): Promise<void> {
	const input = { actor: principalActor(actor.principal), action, target: t.id, detail };
	await deps.audit(t.fromOrgId, input);
	await deps.audit(t.toOrgId, input);
}

export async function listTransfers(deps: TransferServices, orgId: string): Promise<TransferList> {
	const db = await deps.getDb();
	const now = deps.now();
	const [outgoing, incoming] = await Promise.all([
		listTransfersOut(db, orgId),
		listTransfersIn(db, orgId)
	]);
	const viewOne = async (t: Transfer) =>
		view(
			t,
			now,
			t.state === 'accepted' ? await latestTransferRun(db, t.fromOrgId, t.id) : null
		);
	return {
		outgoing: await Promise.all(outgoing.map(viewOne)),
		incoming: await Promise.all(incoming.map(viewOne))
	};
}

// the owner of the source proposes; a kept delegation must be an active one from the source to the target
export async function proposeSiteTransfer(
	deps: TransferServices,
	fromOrgId: string,
	siteId: string,
	actor: TransferActor,
	body: TransferCreate
): Promise<TransferView> {
	const db = await deps.getDb();
	const now = deps.now();
	const site = await getSite(db, fromOrgId, siteId);
	if (site === null || GONE_SITE_STATES.includes(site.state)) {
		throw new ApiError('not_found', 'Not found');
	}
	const target = await getOrganization(db, body.toOrganizationId);
	if (target === null) {
		throw new ApiError('unprocessable', 'That organisation cannot receive this site', {
			reason: 'target_unknown'
		});
	}
	const keep = body.keepDelegationId ?? null;
	if (keep !== null) {
		const rows = await findDelegationBatch(db, keep);
		const usable = rows.some(
			(row) =>
				row.organizationId === fromOrgId &&
				row.agencyOrganizationId === body.toOrganizationId &&
				row.state === 'active' &&
				(row.siteId === null || row.siteId === siteId)
		);
		if (!usable) {
			throw new ApiError(
				'validation',
				'The agency access to keep is not active for this site',
				{
					reason: 'keep_delegation_invalid'
				}
			);
		}
	}
	const checked = proposeTransfer({
		id: crypto.randomUUID(),
		siteId,
		fromOrgId,
		toOrgId: body.toOrganizationId,
		keepDelegationId: keep,
		proposedBy: actor.userId,
		now
	});
	if (!checked.ok) throw mapError(checked.reason);
	try {
		await insertTransfer(db, checked.transfer);
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError(
				'conflict',
				'This site already has a transfer waiting for an answer',
				{
					reason: 'transfer_open'
				}
			);
		}
		throw error;
	}
	await auditBoth(deps, checked.transfer, actor, 'site.transfer.proposed', {
		siteId,
		keepDelegation: keep !== null
	});
	return view(checked.transfer, now);
}

// the receiving owner answers; the site limit of the receiving organisation is read before the accept
export async function acceptSiteTransfer(
	deps: TransferServices,
	toOrgId: string,
	actor: TransferActor,
	id: string
): Promise<TransferView> {
	const db = await deps.getDb();
	const now = deps.now();
	const existing = await findTransfer(db, id);
	if (existing === null || existing.toOrgId !== toOrgId)
		throw new ApiError('not_found', 'Not found');
	if (!deps.targetLimits) {
		throw new ApiError('not_built', 'Checking the receiving plan is not available yet', {
			reason: 'target_limits_not_built'
		});
	}
	const { siteLimit } = await deps.targetLimits(toOrgId);
	if (siteLimit !== null && (await countOrganizationSites(db, toOrgId)) >= siteLimit) {
		throw new ApiError(
			'unprocessable',
			`The receiving organisation is at its limit of ${siteLimit} sites`,
			{ reason: 'site_limit', limit: siteLimit }
		);
	}
	const answer = acceptTransfer(existing, { orgId: toOrgId, by: actor.userId, now });
	if (!answer.ok) throw mapError(answer.reason);
	if (!(await saveTransferState(db, answer.transfer, 'proposed', null))) {
		throw mapError('not_proposed');
	}
	await auditBoth(deps, answer.transfer, actor, 'site.transfer.accepted', {
		siteId: existing.siteId
	});
	return view(answer.transfer, now);
}

export async function declineSiteTransfer(
	deps: TransferServices,
	toOrgId: string,
	actor: TransferActor,
	id: string
): Promise<TransferView> {
	const db = await deps.getDb();
	const now = deps.now();
	const existing = await findTransfer(db, id);
	if (existing === null || existing.toOrgId !== toOrgId)
		throw new ApiError('not_found', 'Not found');
	const answer = declineTransfer(existing, { orgId: toOrgId, by: actor.userId, now });
	if (!answer.ok) throw mapError(answer.reason);
	if (!(await saveTransferState(db, answer.transfer, 'proposed', null))) {
		throw mapError('not_proposed');
	}
	await auditBoth(deps, answer.transfer, actor, 'site.transfer.declined', {
		siteId: existing.siteId
	});
	return view(answer.transfer, now);
}

export async function cancelSiteTransfer(
	deps: TransferServices,
	fromOrgId: string,
	siteId: string,
	actor: TransferActor,
	id: string
): Promise<TransferView> {
	const db = await deps.getDb();
	const now = deps.now();
	const existing = await findTransfer(db, id);
	if (existing === null || existing.fromOrgId !== fromOrgId || existing.siteId !== siteId) {
		throw new ApiError('not_found', 'Not found');
	}
	const answer = cancelTransfer(existing, { orgId: fromOrgId, by: actor.userId, now });
	if (!answer.ok) throw mapError(answer.reason);
	if (!(await saveTransferState(db, answer.transfer, 'proposed', null))) {
		throw mapError('not_proposed');
	}
	await auditBoth(deps, answer.transfer, actor, 'site.transfer.cancelled', {
		siteId: existing.siteId
	});
	return view(answer.transfer, now);
}

// the receiving owner starts the handover of an accepted transfer. The checks run again here, since
// the plan, the sites and the policies may have changed since the accept. A call while a run is open
// answers with that run; a call after a failed run starts the next attempt
export async function completeSiteTransfer(
	deps: TransferServices,
	toOrgId: string,
	actor: TransferActor,
	id: string
): Promise<TransferView> {
	const db = await deps.getDb();
	const now = deps.now();
	const existing = await findTransfer(db, id);
	if (existing === null || existing.toOrgId !== toOrgId)
		throw new ApiError('not_found', 'Not found');
	if (!deps.startCompletion) {
		throw new ApiError('not_built', 'Completing a site transfer is not available yet', {
			reason: 'completion_not_built'
		});
	}
	const last = await latestTransferRun(db, existing.fromOrgId, existing.id);
	if (existing.state === 'completed') return view(existing, now, last);
	const checked = completeTransfer(existing, { now });
	if (!checked.ok) throw mapError(checked.reason);
	if (last !== null && OPEN_RUN.includes(last.status)) return view(existing, now, last);

	if (!deps.targetLimits) {
		throw new ApiError('not_built', 'Checking the receiving plan is not available yet', {
			reason: 'target_limits_not_built'
		});
	}
	const { siteLimit } = await deps.targetLimits(toOrgId);
	if (siteLimit !== null && (await countOrganizationSites(db, toOrgId)) >= siteLimit) {
		throw new ApiError(
			'unprocessable',
			`The receiving organisation is at its limit of ${siteLimit} sites`,
			{ reason: 'site_limit', limit: siteLimit }
		);
	}
	const site = await getSite(db, existing.fromOrgId, existing.siteId);
	if (site === null || GONE_SITE_STATES.includes(site.state)) {
		throw new ApiError('not_found', 'Not found');
	}
	if (site.accountId === null) {
		throw new ApiError('unprocessable', 'This site is not live, so it cannot move yet', {
			reason: 'site_not_live'
		});
	}
	const busy = await findOpenSiteOperation(db, existing.fromOrgId, existing.siteId);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{ reason: 'site_busy', operationId: busy.id }
		);
	}
	const collisions = await transferHostnameCollisions(
		db,
		existing.fromOrgId,
		toOrgId,
		existing.siteId
	);
	if (collisions.length > 0) {
		throw new ApiError(
			'conflict',
			'The receiving organisation already holds a domain of this site for another site',
			{ reason: 'hostname_collision', hostnames: collisions }
		);
	}
	const classified = await getSiteClassification(db, existing.fromOrgId, existing.siteId);
	const groups = await loadPolicyForIncoming(db, {
		orgId: toOrgId,
		classification: classified?.classification ?? null
	});
	refuseBlock(checkTemplate(groups, { template: site.kind }));
	const denied = evaluatePolicy(groups, 'transfer.accept', { stepUp: true });
	if (denied?.reason === 'policy_denied') {
		throw new ApiError(
			'forbidden',
			'A policy group of the receiving organisation refuses this site',
			{
				requires: 'policy',
				policy: denied.policy,
				rule: denied.rule
			}
		);
	}

	const attempt = (last?.attempt ?? 0) + 1;
	const operationId = newId('op');
	const params: SiteTransferInput = {
		operationId,
		transferId: existing.id,
		siteId: existing.siteId,
		fromOrgId: existing.fromOrgId,
		toOrgId,
		accountId: site.accountId
	};
	const plan = planSiteTransfer(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: existing.fromOrgId,
		accountId: site.accountId,
		siteId: existing.siteId,
		type: 'site.transfer',
		status: 'planned',
		idempotencyKey: transferRunKey(existing.id, attempt),
		targetIds: plan.targetIds,
		preconditions: plan.preconditions,
		planDigest: await computePlanDigest(plan),
		blastRadius: plan.blastRadius,
		rollbackPoint: plan.rollbackPoint,
		verification: 'pending',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: plan.steps,
		retryOf: last === null ? null : (last.id as never),
		inputs: params,
		now
	});
	if (created) {
		try {
			await deps.startCompletion({
				workflow: 'site-transfer',
				id: operationId,
				params: params as unknown as Record<string, unknown>
			});
		} catch (error) {
			await updateOperationStatus(
				db,
				existing.fromOrgId,
				operationId,
				operation.version,
				'failed',
				deps.now()
			);
			if (error instanceof ApiError) throw error;
			throw new ApiError('unprocessable', 'The handover could not be started', {
				operationId
			});
		}
		await auditBoth(deps, existing, actor, 'site.transfer.completion_started', {
			siteId: existing.siteId,
			operationId
		});
	}
	return view(existing, now, await latestTransferRun(db, existing.fromOrgId, existing.id));
}
