import { newId } from '@contracts/common';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest } from '@contracts/operations';
import { siteKind, type SiteKind } from '@contracts/sites';
import {
	planNodeSiteCreate,
	type NodeSiteCreateInput
} from '../../../engine/src/workflows/node-site-create';
import { checkHostname } from '../../shared/domain-copy';
import { ApiError } from '../../shared/errors';
import { nodeSiteFailureReason } from '../../shared/operation-copy';
import { nowUtc } from '../../shared/utils/time';
import { getClaim, isHolderLive } from '../db/repos/custom-domains';
import { getNode } from '../db/repos/nodes';
import {
	createSiteOperation,
	findOpenSiteOperation,
	getOperation,
	getOperationByKey,
	getOperationInputs,
	updateOperationStatus,
	type StoredOperation
} from '../db/repos/operations';
import { findLiveSiteByHost, getSite, setSiteState } from '../db/repos/sites';
import { checkNodeSite, type NodeSiteCode } from '../domain/node-site';
import { EngineStartError } from '../integrations/engine';
import { entitlementRefusal, type SiteServices } from './sites';

export interface CreateNodeSiteInput {
	orgId: string;
	userId: string;
	nodeId: string;
	kind: SiteKind;
	name: string;
	host: string;
	idempotencyKey: string;
}

const refuse = (code: NodeSiteCode): ApiError =>
	new ApiError(
		code === 'node_not_found' ? 'not_found' : 'unprocessable',
		nodeSiteFailureReason(code),
		{ reason: code }
	);

// a site row that never became ready, whose create is no longer running, only holds the address
// because it was left behind; it is retired so the claim can move on
async function retireStranded(
	db: Awaited<ReturnType<SiteServices['getDb']>>,
	claim: NonNullable<Awaited<ReturnType<typeof getClaim>>>
): Promise<void> {
	const holder = await getSite(db, claim.organizationId, claim.siteId);
	if (holder === null || holder.readyAt !== null || holder.plane !== 'self-hosted') return;
	if ((await findOpenSiteOperation(db, holder.organizationId, holder.id)) !== null) return;
	await setSiteState(db, holder.organizationId, holder.id, 'deleted', nowUtc().toMillis());
}

// writes the operation and the hidden site row, then starts the engine; the engine owns every
// status after it accepts the start, and the row is listed only when the box has added the site
export async function createNodeSite(
	services: SiteServices,
	input: CreateNodeSiteInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		const held = (await getOperationInputs(
			db,
			input.orgId,
			known.operation.id
		)) as Partial<NodeSiteCreateInput> | null;
		const host = checkHostname(input.host);
		if (
			known.operation.type !== 'node.command' ||
			held?.nodeId !== input.nodeId ||
			!host.ok ||
			held.hostname !== host.hostname
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	if (!siteKind.safeParse(input.kind).success) throw refuse('unsupported_kind');
	const normalized = checkHostname(input.host);
	let claim = normalized.ok ? await getClaim(db, normalized.hostname) : null;
	if (claim !== null) {
		await retireStranded(db, claim);
		claim = await getClaim(db, claim.hostname);
	}
	if (
		normalized.ok &&
		(await findLiveSiteByHost(db, input.orgId, normalized.hostname)) !== null
	) {
		throw refuse('host_taken');
	}
	const node = await getNode(db, input.orgId, input.nodeId);
	const decision = await services.entitlements.check({
		orgId: input.orgId,
		userId: input.userId,
		kind: input.kind
	});
	if (!decision.allow) throw entitlementRefusal(decision.reason);
	const release = services.config.releases[input.kind];
	const verdict = checkNodeSite({
		kind: input.kind,
		host: input.host,
		orgId: input.orgId,
		now: nowUtc().toMillis(),
		node:
			node === null
				? null
				: {
						id: node.id,
						orgId: node.orgId,
						state: node.state,
						lastSeenAt: node.lastSeenAt
					},
		nodes: decision.entitlement.nodes,
		release,
		claim,
		holderLive: claim === null ? false : await isHolderLive(db, claim.siteId)
	});
	if (!verdict.ok) throw refuse(verdict.code);

	const siteId = newId('site');
	const operationId = newId('op');
	const engineInput: NodeSiteCreateInput = {
		operationId,
		orgId: input.orgId,
		siteId,
		nodeId: input.nodeId,
		hostname: verdict.hostname,
		releaseId: release as string
	};
	const plan = planNodeSiteCreate(engineInput);
	const now = nowUtc().toMillis();
	const { operation, created } = await createSiteOperation(
		db,
		{
			id: siteId,
			organizationId: input.orgId,
			name: input.name,
			kind: input.kind,
			category: 'cms',
			plane: 'self-hosted',
			config: 'canonical',
			primaryHostname: verdict.hostname,
			now
		},
		{
			id: operationId,
			organizationId: input.orgId,
			accountId: null,
			siteId,
			type: 'node.command',
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
			inputs: engineInput,
			now
		}
	);
	if (!created) return operation;

	try {
		await services.startOperation({
			workflow: 'node-site-create',
			id: operationId,
			params: engineInput as unknown as Record<string, unknown>
		});
	} catch (error) {
		// the engine never took it, so no one else writes this operation or site
		const failedAt = nowUtc().toMillis();
		await updateOperationStatus(
			db,
			input.orgId,
			operationId,
			operation.version,
			'failed',
			failedAt
		);
		await setSiteState(db, input.orgId, siteId, 'deleted', failedAt);
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The site could not be started', {
			operationId,
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}
	const latest = await getOperation(db, input.orgId, operationId);
	if (!latest) throw new Error(`operation ${operationId} is missing after its start`);
	return latest;
}
