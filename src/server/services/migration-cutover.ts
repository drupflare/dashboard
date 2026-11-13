import { newId } from '@contracts/common';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest } from '@contracts/operations';
import { z } from 'zod';
import { OBSERVATION_OFFSETS_MS } from '../../../contracts/src/migration-cutover';
import {
	changesManifestSchema,
	cutoverKeys,
	digestOfParts,
	parseSourceRef,
	sha256Hex
} from '../../../engine/src/adapters/cutover-store';
import { partKey } from '../../../engine/src/import-parts';
import {
	planMigrationCutover,
	type MigrationCutoverInput
} from '../../../engine/src/workflows/migration-cutover';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import {
	findOpenSiteOperation,
	getOperationByKey,
	listOperationsForSite,
	type StoredOperation
} from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import {
	cutoverViewSchema,
	expectedWindowSeconds,
	readState,
	viewOf,
	type CutoverView,
	type PostWriteChoice,
	type SourceWritePolicy,
	type WindowEstimate
} from '../domain/cutover';
import { EngineStartError, type EngineEventRequest } from '../integrations/engine';
import type { AuditInput } from './audit';
import { principalActor } from './owner-tokens';
import { startRecorded, type SiteServices } from './sites';

export interface CutoverServices {
	// hands an event to the running cutover; refused when nothing is waiting for it
	sendEvent: (request: EngineEventRequest) => Promise<void>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	// the saved copy of the changes the new site took, which the owner downloads
	blobs: { get: (key: string) => Promise<Uint8Array | null> };
	// false until the source and destination adapters exist, so no one starts a move that cannot run
	adaptersBuilt: boolean;
	// unreviewed starting points: the cache time while the move runs, and what each step is expected to take
	ttlSeconds: number;
	estimate: WindowEstimate;
	approvalTimeoutMs: number;
	choiceTimeoutMs: number;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

const HOUR_MS = 3_600_000;

function productionServices(): CutoverServices {
	return {
		sendEvent: notBuilt('Sending an event'),
		audit: notBuilt('The audit log'),
		blobs: { get: notBuilt('Reading the saved changes') },
		adaptersBuilt: false,
		ttlSeconds: 60,
		estimate: { finalDeltaSeconds: 60, promoteSeconds: 30, routeSeconds: 30, ttlSeconds: 60 },
		approvalTimeoutMs: 24 * HOUR_MS,
		choiceTimeoutMs: 7 * 24 * HOUR_MS
	};
}

let installed = productionServices();

export function setCutoverServices(over: Partial<CutoverServices>): void {
	installed = { ...installed, ...over };
}

export function resetCutoverServices(): void {
	installed = productionServices();
}

export function cutoverServices(): CutoverServices {
	return installed;
}

export const cutoverPolicyBody = z.strictObject({
	policy: z.enum(['freeze', 'read-only', 'delta']),
	source: z.strictObject({
		ref: z
			.string()
			.min(1)
			.max(200)
			.refine((ref) => parseSourceRef(ref) !== null, {
				message: 'Enter the key you made for the old server, then the folder of the site'
			})
	}),
	hostname: z
		.string()
		.min(3)
		.max(253)
		.regex(/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i)
});

export const cutoverDecisionBody = z.strictObject({
	value: z.enum(['rollback', 'keep-new', 'abandon-new-data', 'export-changes'])
});

export const cutoverPlanSchema = z.object({
	// whether this site can take a cutover, and why not
	ready: z.boolean(),
	available: z.boolean(),
	policies: z.array(
		z.object({
			policy: z.enum(['freeze', 'read-only', 'delta']),
			expectedWindowSeconds: z.int().nonnegative()
		})
	),
	observationOffsetsMs: z.array(z.int().positive()),
	// the cache time the owner sets on the address while the move runs
	ttlSeconds: z.int().positive(),
	cutover: cutoverViewSchema.nullable()
});

export type CutoverPlan = z.infer<typeof cutoverPlanSchema>;

const POLICIES: SourceWritePolicy[] = ['freeze', 'read-only', 'delta'];

// the site that takes the traffic: managed, live and with an address of its own
async function destinationOf(services: SiteServices, orgId: string, siteId: string) {
	const db = await services.getDb();
	const site = await getReadySite(db, orgId, siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const ready =
		site.plane === 'managed' &&
		site.state === 'active' &&
		site.accountId !== null &&
		site.primaryHostname !== null;
	return { db, site, ready };
}

function viewOfOperation(stored: StoredOperation, siteId: string): CutoverView | null {
	const state = readState(stored.operation.cursor);
	if (state === null) return null;
	return viewOf(
		stored.operation.id,
		siteId,
		state,
		stored.operation.steps.map((step) => ({ id: step.id, name: step.name, state: step.state }))
	);
}

async function latestCutover(
	db: Awaited<ReturnType<SiteServices['getDb']>>,
	orgId: string,
	siteId: string
): Promise<StoredOperation | null> {
	const rows = await listOperationsForSite(db, orgId, siteId, { count: 50 });
	return rows.find((row) => row.operation.type === 'migration.cutover') ?? null;
}

// the plan, the state of the latest cutover on the site, and whether one can start
export async function readCutover(
	services: SiteServices,
	cutover: CutoverServices,
	input: { orgId: string; siteId: string }
): Promise<CutoverPlan> {
	const { db, ready } = await destinationOf(services, input.orgId, input.siteId);
	const latest = await latestCutover(db, input.orgId, input.siteId);
	return {
		ready,
		available: cutover.adaptersBuilt,
		policies: POLICIES.map((policy) => ({
			policy,
			expectedWindowSeconds: expectedWindowSeconds(policy, cutover.estimate)
		})),
		observationOffsetsMs: [...OBSERVATION_OFFSETS_MS],
		ttlSeconds: cutover.ttlSeconds,
		cutover: latest === null ? null : viewOfOperation(latest, input.siteId)
	};
}

export interface StartCutoverInput {
	orgId: string;
	siteId: string;
	policy: SourceWritePolicy;
	source: { ref: string };
	hostname: string;
	idempotencyKey: string;
}

// the engine owns every status after it accepts the start; the source is read and frozen on request
// and never changed in any other way
export async function startCutover(
	services: SiteServices,
	cutover: CutoverServices,
	input: StartCutoverInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'migration.cutover' ||
			known.operation.targetIds[0] !== input.siteId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	if (!cutover.adaptersBuilt) {
		throw new ApiError('not_built', 'Moving a site with a cutover is not available yet');
	}
	const { site, ready } = await destinationOf(services, input.orgId, input.siteId);
	if (!ready || site.accountId === null || site.primaryHostname === null) {
		throw new ApiError(
			'unprocessable',
			'This site is not a live managed site, so it cannot take a move',
			{
				reason: 'no_ready_destination'
			}
		);
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
	const params: MigrationCutoverInput = {
		operationId,
		orgId: input.orgId,
		site: { id: site.id, accountId: site.accountId },
		source: input.source,
		hostname: input.hostname.toLowerCase(),
		policy: input.policy,
		ttlSeconds: cutover.ttlSeconds,
		expectedWindowSeconds: expectedWindowSeconds(input.policy, cutover.estimate),
		approvalTimeoutMs: cutover.approvalTimeoutMs,
		choiceTimeoutMs: cutover.choiceTimeoutMs
	};
	const plan = planMigrationCutover(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'migration.cutover',
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
			workflow: 'migration-cutover',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The move could not be started'
	);
}

export interface DecideInput {
	orgId: string;
	siteId: string;
	principal: Principal;
}

async function runningCutover(services: SiteServices, input: DecideInput) {
	const { db } = await destinationOf(services, input.orgId, input.siteId);
	const latest = await latestCutover(db, input.orgId, input.siteId);
	const state = latest === null ? null : readState(latest.operation.cursor);
	if (latest === null || state === null) {
		throw new ApiError('not_found', 'No move has started for this site');
	}
	return { operation: latest.operation, state };
}

async function deliver(
	cutover: CutoverServices,
	request: EngineEventRequest,
	nothingWaiting: string
): Promise<void> {
	try {
		await cutover.sendEvent(request);
	} catch (error) {
		if (error instanceof EngineStartError && error.code === 'not_running') {
			throw new ApiError('conflict', nothingWaiting, { reason: 'not_waiting' });
		}
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The move could not be told. Try again in a moment.', {
			reason: error instanceof EngineStartError ? error.code : 'unavailable'
		});
	}
}

// the approval is recorded before it is sent, so a send that fails still leaves a trace
export async function approveCutover(
	services: SiteServices,
	cutover: CutoverServices,
	input: DecideInput
): Promise<CutoverView> {
	const { operation, state } = await runningCutover(services, input);
	if (state.state !== 'awaiting-approval') {
		throw new ApiError('conflict', 'This move is not waiting for approval', {
			reason: 'not_awaiting_approval',
			state: state.state
		});
	}
	await cutover.audit(input.orgId, {
		actor: principalActor(input.principal),
		action: 'site.cutover.approve',
		target: input.siteId,
		detail: { operationId: operation.id, policy: state.policy }
	});
	await deliver(
		cutover,
		{
			workflow: 'migration-cutover',
			id: operation.id,
			type: 'cutover-approval',
			payload: { approvedBy: principalActor(input.principal) }
		},
		'This move is not waiting for approval'
	);
	return viewOf(operation.id, input.siteId, state, stepsOf(operation));
}

const stepsOf = (operation: StoredOperation['operation']): CutoverView['steps'] =>
	operation.steps.map((step) => ({ id: step.id, name: step.name, state: step.state }));

// a reversal or one of the three choices; the engine reads the write count itself and refuses a
// reversal that would lose writes, which shows in the state it records
export async function decideCutover(
	services: SiteServices,
	cutover: CutoverServices,
	input: DecideInput & { value: 'rollback' | PostWriteChoice }
): Promise<CutoverView> {
	const { operation, state } = await runningCutover(services, input);
	if (state.state !== 'observing' && state.state !== 'promoted') {
		throw new ApiError('conflict', 'This move is not at a point where it can be changed', {
			reason: 'not_observing',
			state: state.state
		});
	}
	await cutover.audit(input.orgId, {
		actor: principalActor(input.principal),
		action: 'site.cutover.decide',
		target: input.siteId,
		detail: { operationId: operation.id, value: input.value, writes: state.destinationWrites }
	});
	await deliver(
		cutover,
		{
			workflow: 'migration-cutover',
			id: operation.id,
			type: 'cutover-decision',
			payload:
				input.value === 'rollback'
					? { kind: 'rollback' }
					: { kind: 'choice', value: input.value }
		},
		'This move is no longer running'
	);
	return viewOf(operation.id, input.siteId, state, stepsOf(operation));
}

// the audit row goes first, so a download that fails still leaves a trace. The file is the SQL the
// engine saved; each part is checked on the way out and a bad one ends the download as a failure,
// never as a short file
export async function exportCutoverChanges(
	services: SiteServices,
	cutover: CutoverServices,
	input: DecideInput
): Promise<Response> {
	if (input.principal.kind !== 'user') {
		throw new ApiError('forbidden', 'This action needs a signed-in session', {
			reason: 'session_only'
		});
	}
	const { db } = await destinationOf(services, input.orgId, input.siteId);
	const latest = await latestCutover(db, input.orgId, input.siteId);
	const state = latest === null ? null : readState(latest.operation.cursor);
	if (latest === null || state === null || state.exportReference === null) {
		throw new ApiError('not_found', 'No changes have been saved for this site');
	}
	const prefix = cutoverKeys.changes(input.orgId, latest.operation.id);
	await cutover.audit(input.orgId, {
		actor: principalActor(input.principal),
		action: 'site.cutover.export',
		target: input.siteId,
		detail: { operationId: latest.operation.id }
	});
	const stored = await cutover.blobs.get(cutoverKeys.manifest(prefix));
	const parsed =
		stored === null
			? null
			: changesManifestSchema.safeParse(JSON.parse(new TextDecoder().decode(stored)));
	if (parsed === null || !parsed.success) {
		throw new ApiError('internal', 'The saved changes are incomplete');
	}
	const manifest = parsed.data;
	const hashes: string[] = [];
	let next = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (next >= manifest.parts) {
				if ((await digestOfParts(hashes)) !== manifest.digest) {
					return controller.error(
						new Error('the saved changes do not match their record')
					);
				}
				return controller.close();
			}
			const bytes = await cutover.blobs.get(partKey(prefix, next, 'sql'));
			if (bytes === null) return controller.error(new Error('a saved part is missing'));
			hashes.push(await sha256Hex(bytes));
			next++;
			controller.enqueue(bytes);
		}
	});
	return new Response(body, {
		status: 200,
		headers: {
			'Content-Type': 'application/sql; charset=utf-8',
			'Content-Disposition': `attachment; filename="new-changes-${input.siteId}.sql"`,
			'Content-Length': String(manifest.bytes),
			'Cache-Control': 'no-store'
		}
	});
}
