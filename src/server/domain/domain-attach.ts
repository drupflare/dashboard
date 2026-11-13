import { z } from 'zod';
import {
	ATTACH_STAGES,
	STAGE_COPY,
	attachFailureReason,
	type AttachStage,
	type DnsRecord
} from '../../shared/domain-copy';

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
	startedAt: number;
	updatedAt: number;
}

export type AttachEvent =
	| { type: 'requested'; records: DnsRecord[] }
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
		case 'observed': {
			if (state.stages.ownership === 'waiting') {
				throw new AttachOrderError('a check came before the request was made');
			}
			const { observation } = event;
			let next: AttachState = {
				...state,
				checks: state.checks + 1,
				records: observation.records.length > 0 ? observation.records : state.records
			};
			if (next.stages.ownership === 'pending') {
				if (observation.hostnameStatus === 'active') {
					next = settle(settle(next, 'ownership', 'done'), 'certificate', 'pending');
				} else if (observation.hostnameStatus !== 'pending') {
					return fail(next, 'ownership_failed');
				}
			}
			if (next.stages.certificate === 'pending') {
				if (observation.certificateStatus === 'failed')
					return fail(next, 'certificate_failed');
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
			? parsed
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
}

export type ClaimDecision =
	| { kind: 'insert'; epoch: number }
	| { kind: 'keep'; epoch: number }
	| { kind: 'takeover'; epoch: number; previous: ClaimRow }
	| { kind: 'refuse' };

// a hostname moves to another site only when the site that holds it is gone or released it
export function decideClaim(
	row: ClaimRow | null,
	who: { organizationId: string; siteId: string },
	holderLive: boolean
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
	return { kind: 'refuse' };
}

// #endregion

// #region the view the page reads

export const attachViewSchema = z.object({
	operationId: z.string(),
	hostname: z.string(),
	status: z.enum(['running', 'succeeded', 'failed']),
	stages: z.array(
		z.object({
			id: z.enum(ATTACH_STAGES),
			label: z.string(),
			state: z.enum(['waiting', 'pending', 'done', 'failed']),
			text: z.string()
		})
	),
	records: z.array(
		z.object({
			purpose: z.enum(['ownership', 'certificate', 'traffic']),
			type: z.enum(['TXT', 'CNAME']),
			name: z.string(),
			value: z.string()
		})
	),
	checks: z.int().nonnegative(),
	reason: z.string().nullable(),
	updatedAt: z.int().nonnegative()
});

export type AttachView = z.infer<typeof attachViewSchema>;

export function viewOf(operationId: string, state: AttachState): AttachView {
	return {
		operationId,
		hostname: state.hostname,
		status: state.reason !== null ? 'failed' : isComplete(state) ? 'succeeded' : 'running',
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
		checks: state.checks,
		reason: state.reason === null ? null : (attachFailureReason(state.reason) ?? state.reason),
		updatedAt: state.updatedAt
	};
}

// #endregion
