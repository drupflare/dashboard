import { newId } from '@contracts/common';
import { computePlanDigest, DEFAULT_CHANGE_BUDGET } from '@contracts/operations';
import { z } from 'zod';
import {
	planDomainAttach,
	type DomainAttachInput
} from '../../../engine/src/workflows/domain-attach';
import {
	deriveChallenge,
	loadChallengeKeys,
	type ChallengeKeys
} from '../../shared/custody/challenge';
import { CryptoError } from '../../shared/custody/envelope';
import {
	attachFailureReason,
	checkHostname,
	hazardText,
	RECORD_STATUS_COPY
} from '../../shared/domain-copy';
import { ApiError } from '../../shared/errors';
import { failureReason } from '../../shared/operation-copy';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import {
	getClaim,
	isHolderLive,
	listAttachedDomains,
	releaseWaitingClaim
} from '../db/repos/custom-domains';
import {
	findOpenSiteOperation,
	getOperationByKey,
	getOperationInputs,
	listOperationsForSite,
	type StoredOperation
} from '../db/repos/operations';
import { getReadySite } from '../db/repos/sites';
import {
	checkRecords,
	isApex,
	mergeRecords,
	recordList,
	type DnsResolver
} from '../domain/dns-check';
import {
	attachViewSchema,
	DEFAULT_WAIT_MS,
	dnsRecordSchema,
	prospectiveEpoch,
	readAttachState,
	startState,
	viewOf,
	type AttachView
} from '../domain/domain-attach';
import { dohResolver } from '../integrations/dns-resolver';
import { startRecorded, type SiteServices } from './sites';

export const domainAttachBody = z.strictObject({
	hostname: z.string().min(3).max(253)
});

export const domainPlanSchema = z.object({
	// whether this site can take a domain, which only a live managed site can
	ready: z.boolean(),
	// whether custom domains are switched on for the platform; an attach waits while they are off
	enabled: z.boolean(),
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
			expiresAt: null,
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

// an attach that claimed the name and still waits on its proof, or sits parked, reads as stopped once
// the owner gave the name up or another site holds it, so the owner is told at once even when the
// engine has not woken to find out
async function withDisplacement(
	db: Awaited<ReturnType<SiteServices['getDb']>>,
	input: { orgId: string; siteId: string },
	view: AttachView
): Promise<AttachView> {
	const waitingOnProof =
		view.status === 'running' &&
		view.stages.some((s) => s.id === 'ownership' && s.state === 'pending');
	// a parked attach holds its proven claim, which the owner can give up
	if (!waitingOnProof && view.status !== 'waiting') return view;
	const claim = await getClaim(db, view.hostname);
	if (claim === null) return view;
	const ours = claim.siteId === input.siteId && claim.organizationId === input.orgId;
	if (ours && claim.state === 'released') {
		return {
			...view,
			status: 'failed',
			expiresAt: null,
			reason: attachFailureReason('attach_cancelled')
		};
	}
	if (ours) return view;
	return {
		...view,
		status: 'failed',
		expiresAt: null,
		reason: attachFailureReason('hostname_displaced')
	};
}

// the state of the latest attach on the site and the domains that serve it now
export async function readDomain(
	services: SiteServices,
	input: { orgId: string; siteId: string }
): Promise<DomainPlan> {
	const { db, ready } = await liveSite(services, input.orgId, input.siteId);
	const rows = await listOperationsForSite(db, input.orgId, input.siteId, { count: 50 });
	const latest = rows.find((row) => row.operation.type === 'domain.attach') ?? null;
	const attach = latest === null ? null : await viewOfOperation(db, input.orgId, latest);
	return {
		ready,
		enabled: installed?.target != null,
		attached: await listAttachedDomains(db, input.orgId, input.siteId),
		attach: attach === null ? null : await withDisplacement(db, input, attach)
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

export const domainReleaseBody = z.strictObject({
	hostname: z.string().min(3).max(253)
});

export const domainReleaseSchema = z.object({
	hostname: z.string(),
	// false when this site held nothing under the name, so a repeat answers the same way
	released: z.boolean()
});

export type DomainRelease = z.infer<typeof domainReleaseSchema>;

// ends a claim before the provider knows the name: a running attach stops at its next look, and a
// parked one gives the name up. A name the provider already has is not released from here
export async function releaseDomain(
	services: SiteServices,
	input: { orgId: string; siteId: string; hostname: string }
): Promise<DomainRelease> {
	const hostname = checkedName(input.hostname);
	const db = await services.getDb();
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const released = await releaseWaitingClaim(db, {
		orgId: input.orgId,
		siteId: input.siteId,
		hostname,
		now: nowUtc().toMillis()
	});
	if (released) return { hostname, released: true };
	const row = await getClaim(db, hostname);
	if (
		row !== null &&
		row.organizationId === input.orgId &&
		row.siteId === input.siteId &&
		row.state !== 'released'
	) {
		throw new ApiError(
			'conflict',
			'This domain is already set up, so it cannot be cancelled here.',
			{ reason: 'domain_in_use' }
		);
	}
	return { hostname, released: false };
}

function checkedName(raw: string): string {
	const checked = checkHostname(raw);
	if (!checked.ok) {
		throw new ApiError('unprocessable', checked.message, { reason: checked.code });
	}
	return checked.hostname;
}

// #region the check

export interface DomainServices {
	keys: () => Promise<ChallengeKeys>;
	resolver: DnsResolver;
	// the name visitors point at; null while custom domains are off
	target: string | null;
}

let installed: DomainServices | null = null;

export function setDomainServices(services: DomainServices | null): void {
	installed = services;
}

export function resetDomainServices(): void {
	installed = null;
}

// the key ring loads on first use, and a missing KEK_V<n> answers 501 until one is set
export function domainServicesOf(env: {
	secrets: Record<string, string | undefined>;
	target: string | undefined;
	fetch?: typeof fetch;
}): DomainServices {
	let keys: Promise<ChallengeKeys> | undefined;
	return {
		keys: async () => {
			keys ??= loadChallengeKeys(env.secrets);
			try {
				return await keys;
			} catch (error) {
				keys = undefined;
				if (error instanceof CryptoError && error.code === 'no_keys') {
					throw new ApiError('not_built', 'Domain checks are not available yet');
				}
				throw error;
			}
		},
		resolver: dohResolver(env.fetch),
		target: env.target === undefined || env.target === '' ? null : env.target
	};
}

export const domainCheckBody = z.strictObject({
	hostname: z.string().min(3).max(253)
});

export const domainCheckSchema = z.object({
	hostname: z.string(),
	// a bare domain, where the routing record needs an alias that not every DNS provider offers
	apex: z.boolean(),
	// another site holds the domain, so no records are listed
	held: z.boolean(),
	// false while custom domains are off, when no routing record exists to show yet
	routingKnown: z.boolean(),
	records: z.array(
		dnsRecordSchema.extend({
			status: z.enum(['ok', 'missing', 'wrong', 'unknown']),
			statusText: z.string(),
			found: z.array(z.string())
		})
	),
	hazards: z.array(
		z.object({
			code: z.enum(['apex_cname', 'conflicting_records', 'caa_blocks', 'second_challenge']),
			text: z.string()
		})
	),
	// some record could not be read, which is never reported as missing
	unknown: z.boolean()
});

export type DomainCheck = z.infer<typeof domainCheckSchema>;

// every record the owner adds, read live; starts nothing and writes nothing
export async function checkDomain(
	services: SiteServices,
	input: { orgId: string; siteId: string; hostname: string }
): Promise<DomainCheck> {
	const domain = installed;
	if (domain === null) throw new ApiError('not_built', 'Domain checks are not available yet');
	const hostname = checkedName(input.hostname);
	const { db, site, ready } = await liveSite(services, input.orgId, input.siteId);
	if (!ready) {
		throw new ApiError('unprocessable', 'This site is not live, so it cannot take a domain', {
			reason: 'site_not_live'
		});
	}
	const row = await getClaim(db, hostname);
	const holderLive = row === null ? false : await isHolderLive(db, row.siteId);
	const epoch = prospectiveEpoch(
		row,
		{ organizationId: input.orgId, siteId: site.id },
		holderLive,
		nowUtc().toMillis()
	);
	const apex = await isApex(domain.resolver, hostname);
	const base = { hostname, apex, held: false, routingKnown: domain.target !== null };
	if (epoch === null) {
		return { ...base, held: true, records: [], hazards: [], unknown: false };
	}
	const challenge = await deriveChallenge(await domain.keys(), {
		siteId: site.id,
		hostname,
		epoch
	});
	let records = recordList({ hostname, apex, target: domain.target, challenge: challenge.value });
	// the certificate records exist once the provider has been asked, and only the running attach holds them
	const rows = await listOperationsForSite(db, input.orgId, site.id, { count: 50 });
	const latest = rows.find((item) => item.operation.type === 'domain.attach');
	const state = latest === undefined ? null : readAttachState(latest.operation.cursor);
	if (state !== null && state.hostname === hostname && state.reason === null) {
		records = mergeRecords(
			records,
			state.records.filter((record) => record.purpose === 'certificate')
		);
	}
	const result = await checkRecords(domain.resolver, {
		hostname,
		apex,
		records,
		accepted: challenge.accepted,
		target: domain.target
	});
	return {
		...base,
		records: result.records.map((record) => ({
			...record,
			statusText: RECORD_STATUS_COPY[record.status]
		})),
		hazards: result.hazards.map((hazard) => ({
			code: hazard.code,
			text: hazardText(hazard.code, hazard.found)
		})),
		unknown: result.unknown
	};
}

// #endregion
