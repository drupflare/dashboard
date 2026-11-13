import { z } from 'zod';
import {
	ATTACH_STAGES,
	STAGE_COPY,
	WAITING_COPY,
	attachFailureReason,
	type AttachStage,
	type DnsRecord
} from '../../shared/domain-copy';
import { mergeRecords } from './dns-check';

export type StageState = 'waiting' | 'pending' | 'done' | 'failed';
export type HostnameStatus = 'pending' | 'active' | 'moved' | 'deleted' | 'blocked';
export type CertificateStatus = 'none' | 'pending' | 'active' | 'failed';

// what the provider reports about one hostname at one moment
export interface Observation {
	hostnameStatus: HostnameStatus;
	certificateStatus: CertificateStatus;
	records: DnsRecord[];
}

export interface AttachState {
	v: 1;
	hostname: string;
	stages: Record<AttachStage, StageState>;
	records: DnsRecord[];
	checks: number;
	// the failure code the owner copy reads; null until a stage fails
	reason: string | null;
	// why the attach stopped without failing: the provider is off, so the owner waits and tries again
	waiting: string | null;
	startedAt: number;
	updatedAt: number;
}

export type AttachEvent =
	| { type: 'requested'; records: DnsRecord[] }
	| { type: 'checked' }
	| { type: 'proven' }
	| { type: 'registered'; records: DnsRecord[] }
	| { type: 'parked'; code: string }
	| { type: 'observed'; observation: Observation }
	| { type: 'routed' }
	| { type: 'verified'; answered: boolean }
	| { type: 'failed'; code: string };

export class AttachOrderError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'AttachOrderError';
	}
}

export function startState(hostname: string, now: number): AttachState {
	return {
		v: 1,
		hostname,
		stages: {
			ownership: 'waiting',
			certificate: 'waiting',
			routing: 'waiting',
			verification: 'waiting'
		},
		records: [],
		checks: 0,
		reason: null,
		waiting: null,
		startedAt: now,
		updatedAt: now
	};
}

// the first stage that is not done; null when all four are
export function currentStage(state: AttachState): AttachStage | null {
	return ATTACH_STAGES.find((stage) => state.stages[stage] !== 'done') ?? null;
}

export function isFailed(state: AttachState): boolean {
	return state.reason !== null;
}

export function isWaiting(state: AttachState): boolean {
	return state.reason === null && state.waiting !== null;
}

export function isComplete(state: AttachState): boolean {
	return state.reason === null && ATTACH_STAGES.every((stage) => state.stages[stage] === 'done');
}

function settle(state: AttachState, stage: AttachStage, to: StageState): AttachState {
	return { ...state, stages: { ...state.stages, [stage]: to } };
}

function fail(state: AttachState, code: string): AttachState {
	const stage = currentStage(state);
	if (stage === null || state.reason !== null) return state;
	return { ...settle(state, stage, 'failed'), reason: code };
}

// a check that changes nothing the owner sees is not written, so a long wait stays cheap
export function visiblyChanged(before: AttachState, after: AttachState): boolean {
	return (
		before.reason !== after.reason ||
		before.waiting !== after.waiting ||
		ATTACH_STAGES.some((stage) => before.stages[stage] !== after.stages[stage]) ||
		JSON.stringify(before.records) !== JSON.stringify(after.records)
	);
}

// each stage needs its own evidence in order, so a later state is unreachable while an earlier one
// is open; an event that skips ahead is a bug in the caller and throws
export function advance(state: AttachState, event: AttachEvent, now: number): AttachState {
	if (state.reason !== null) return state;
	const next = step(state, event);
	return next === state ? state : { ...next, updatedAt: now };
}

function step(state: AttachState, event: AttachEvent): AttachState {
	switch (event.type) {
		case 'requested': {
			if (state.stages.ownership !== 'waiting') return state;
			return { ...settle(state, 'ownership', 'pending'), records: event.records };
		}
		case 'checked': {
			if (state.stages.ownership === 'waiting') {
				throw new AttachOrderError('a check came before the request was made');
			}
			return { ...state, checks: state.checks + 1 };
		}
		case 'proven': {
			if (state.stages.ownership === 'waiting') {
				throw new AttachOrderError('ownership was proven before the request was made');
			}
			if (state.stages.ownership === 'done') return state;
			return settle(settle(state, 'ownership', 'done'), 'certificate', 'pending');
		}
		case 'registered': {
			if (state.stages.ownership !== 'done') {
				throw new AttachOrderError('the provider was asked before ownership was proven');
			}
			return { ...state, records: mergeRecords(state.records, event.records) };
		}
		case 'parked': {
			if (state.stages.ownership !== 'done') {
				throw new AttachOrderError('the attach parked before ownership was proven');
			}
			return { ...settle(state, 'certificate', 'waiting'), waiting: event.code };
		}
		case 'observed': {
			if (state.stages.ownership !== 'done') {
				throw new AttachOrderError('the provider was read before ownership was proven');
			}
			const { observation } = event;
			let next: AttachState = {
				...state,
				checks: state.checks + 1,
				records: mergeRecords(state.records, observation.records)
			};
			const open = next.stages.certificate === 'pending' || next.stages.routing === 'pending';
			if (
				open &&
				observation.hostnameStatus !== 'pending' &&
				observation.hostnameStatus !== 'active'
			) {
				return fail(next, 'custom_domains_refused');
			}
			if (next.stages.certificate === 'pending') {
				if (observation.certificateStatus === 'failed') {
					return fail(next, 'certificate_failed');
				}
				if (observation.certificateStatus === 'active') {
					next = settle(settle(next, 'certificate', 'done'), 'routing', 'pending');
				}
			}
			return next;
		}
		case 'routed': {
			if (state.stages.certificate !== 'done') {
				throw new AttachOrderError('routing came before the certificate was issued');
			}
			if (state.stages.routing === 'done') return state;
			return settle(settle(state, 'routing', 'done'), 'verification', 'pending');
		}
		case 'verified': {
			if (state.stages.routing !== 'done') {
				throw new AttachOrderError('the final check came before routing was in place');
			}
			if (!event.answered || state.stages.verification === 'done') return state;
			return settle(state, 'verification', 'done');
		}
		case 'failed':
			return fail(state, event.code);
	}
}

// a short wait while the owner is likely still at their DNS provider, then longer ones
export function pollDelayMs(attempt: number): number {
	if (attempt < 10) return 30_000;
	if (attempt < 40) return 300_000;
	return 1_800_000;
}

export const DEFAULT_WAIT_MS = 72 * 3_600_000;

export function readAttachState(cursor: string | null): AttachState | null {
	if (cursor === null) return null;
	try {
		const parsed = JSON.parse(cursor) as AttachState;
		return typeof parsed === 'object' && parsed !== null && parsed.v === 1 && 'stages' in parsed
			? { ...parsed, waiting: parsed.waiting ?? null }
			: null;
	} catch {
		return null;
	}
}

// #region claims

export interface ClaimRow {
	hostname: string;
	organizationId: string;
	siteId: string;
	operationId: string;
	// rises each time the hostname changes hands and never falls
	epoch: number;
	state: 'claimed' | 'routed' | 'released';
	providerId: string | null;
	// the epoch under which the owner proved the domain; a proof counts only while it equals `epoch`
	ownershipEpoch: number | null;
	updatedAt: number;
}

export function isProven(row: ClaimRow | null): boolean {
	return row !== null && row.state !== 'released' && row.ownershipEpoch === row.epoch;
}

// how long a claim may wait for its proof before it stops holding the name
export const CLAIM_HOLD_MS = DEFAULT_WAIT_MS;

// a claim that still waits for its proof; a routed or proven one is not contestable
export function isUnproven(row: ClaimRow): boolean {
	return row.state === 'claimed' && !isProven(row);
}

export function isExpired(row: ClaimRow, now: number): boolean {
	return isUnproven(row) && now - row.updatedAt >= CLAIM_HOLD_MS;
}

// the epoch a claim by this site carries, which the ownership value is derived from; null when the
// hostname is held by a proven claim and the claim would be refused. A hostname held by an unproven
// claim reads as contestable, so the page shows the value a takeover would be checked against
export function prospectiveEpoch(
	row: ClaimRow | null,
	who: { organizationId: string; siteId: string },
	holderLive: boolean,
	now?: number
): number | null {
	const decision = decideClaim(row, who, holderLive, { now, contest: true });
	return decision.kind === 'refuse' ? null : decision.epoch;
}

export type ClaimDecision =
	| { kind: 'insert'; epoch: number }
	| { kind: 'keep'; epoch: number }
	| { kind: 'takeover'; epoch: number; previous: ClaimRow }
	// an unproven claim past its hold; the write must still find it unproven
	| { kind: 'expired'; epoch: number; previous: ClaimRow }
	// an unproven live claim; the challenger wins only with its own proof for `epoch`, which is the
	// epoch after the takeover, since that is the epoch the challenger's value is derived from
	| { kind: 'contest'; epoch: number; previous: ClaimRow }
	| { kind: 'refuse' };

export interface ClaimTerms {
	// the clock for the hold; without it an unproven claim never expires
	now?: number;
	// the caller can show proof, so an unproven live claim is contestable
	contest?: boolean;
}

// a hostname moves to another site when the site that holds it is gone, released it, or never proved
// the domain and either ran out its hold or lost to a challenger who did
export function decideClaim(
	row: ClaimRow | null,
	who: { organizationId: string; siteId: string },
	holderLive: boolean,
	terms: ClaimTerms = {}
): ClaimDecision {
	if (row === null) return { kind: 'insert', epoch: 1 };
	if (
		row.state !== 'released' &&
		row.siteId === who.siteId &&
		row.organizationId === who.organizationId
	) {
		return { kind: 'keep', epoch: row.epoch };
	}
	if (row.state === 'released' || !holderLive) {
		return { kind: 'takeover', epoch: row.epoch + 1, previous: row };
	}
	if (terms.now !== undefined && isExpired(row, terms.now)) {
		return { kind: 'expired', epoch: row.epoch + 1, previous: row };
	}
	if (terms.contest === true && isUnproven(row)) {
		return { kind: 'contest', epoch: row.epoch + 1, previous: row };
	}
	return { kind: 'refuse' };
}

// #endregion

// #region the view the page reads

export const dnsRecordSchema = z.object({
	purpose: z.enum(['ownership', 'certificate', 'traffic']),
	type: z.enum(['TXT', 'CNAME']),
	name: z.string(),
	value: z.string(),
	note: z.string().optional()
});

export const attachViewSchema = z.object({
	operationId: z.string(),
	hostname: z.string(),
	status: z.enum(['running', 'waiting', 'succeeded', 'failed']),
	stages: z.array(
		z.object({
			id: z.enum(ATTACH_STAGES),
			label: z.string(),
			state: z.enum(['waiting', 'pending', 'done', 'failed']),
			text: z.string()
		})
	),
	records: z.array(dnsRecordSchema),
	// the plain sentence that explains a waiting attach; null otherwise
	notice: z.string().nullable(),
	checks: z.int().nonnegative(),
	reason: z.string().nullable(),
	// when a running attach stops waiting for the ownership record; null once the record is found
	expiresAt: z.int().nonnegative().nullable(),
	updatedAt: z.int().nonnegative()
});

export type AttachView = z.infer<typeof attachViewSchema>;

export function viewOf(operationId: string, state: AttachState): AttachView {
	return {
		operationId,
		hostname: state.hostname,
		status:
			state.reason !== null
				? 'failed'
				: isComplete(state)
					? 'succeeded'
					: isWaiting(state)
						? 'waiting'
						: 'running',
		stages: ATTACH_STAGES.map((id) => ({
			id,
			label: STAGE_COPY[id].label,
			state: state.stages[id],
			text:
				state.stages[id] === 'done'
					? STAGE_COPY[id].done
					: state.stages[id] === 'pending'
						? STAGE_COPY[id].pending
						: STAGE_COPY[id].waiting
		})),
		// the records stay visible after a failure, so the owner can fix what is missing
		records: state.records,
		notice: isWaiting(state) ? WAITING_COPY : null,
		checks: state.checks,
		reason: state.reason === null ? null : (attachFailureReason(state.reason) ?? state.reason),
		expiresAt:
			state.reason === null && state.stages.ownership === 'pending'
				? state.startedAt + DEFAULT_WAIT_MS
				: null,
		updatedAt: state.updatedAt
	};
}

// #endregion
