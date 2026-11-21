export const TRANSFER_STATES = [
	'proposed',
	'accepted',
	'declined',
	'cancelled',
	'completed'
] as const;
export type TransferState = (typeof TRANSFER_STATES)[number];

// the moves run in this order; each one is recorded before the next starts
export const TRANSFER_STEPS = ['ownership', 'billing', 'access', 'epoch'] as const;
export type TransferStep = (typeof TRANSFER_STEPS)[number];
export type TransferView = TransferState | 'expired';

export const TRANSFER_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface Transfer {
	id: string;
	siteId: string;
	fromOrgId: string;
	toOrgId: string;
	state: TransferState;
	keepDelegationId: string | null;
	proposedBy: string;
	proposedAt: number;
	expiresAt: number;
	decidedBy: string | null;
	decidedAt: number | null;
}

export type TransferError =
	'same_org' | 'not_proposed' | 'not_accepted' | 'expired' | 'not_party' | 'wrong_side';

export type TransferResult =
	{ ok: true; transfer: Transfer } | { ok: false; reason: TransferError };

const fail = (reason: TransferError): TransferResult => ({ ok: false, reason });

export function proposeTransfer(input: {
	id: string;
	siteId: string;
	fromOrgId: string;
	toOrgId: string;
	keepDelegationId: string | null;
	proposedBy: string;
	now: number;
}): TransferResult {
	if (input.fromOrgId === input.toOrgId) return fail('same_org');
	return {
		ok: true,
		transfer: {
			id: input.id,
			siteId: input.siteId,
			fromOrgId: input.fromOrgId,
			toOrgId: input.toOrgId,
			state: 'proposed',
			keepDelegationId: input.keepDelegationId,
			proposedBy: input.proposedBy,
			proposedAt: input.now,
			expiresAt: input.now + TRANSFER_WINDOW_MS,
			decidedBy: null,
			decidedAt: null
		}
	};
}

// the window is closed at its last instant, the same rule a delegation expiry uses
export function transferView(t: Transfer, now: number): TransferView {
	return t.state === 'proposed' && now >= t.expiresAt ? 'expired' : t.state;
}

// only the receiving organisation answers a proposal; the other side gets `wrong_side`
function answerProposal(
	t: Transfer,
	input: { orgId: string; by: string; now: number }
): TransferResult {
	if (input.orgId === t.fromOrgId) return fail('wrong_side');
	if (input.orgId !== t.toOrgId) return fail('not_party');
	if (t.state !== 'proposed') return fail('not_proposed');
	if (input.now >= t.expiresAt) return fail('expired');
	return { ok: true, transfer: { ...t, decidedBy: input.by, decidedAt: input.now } };
}

export function acceptTransfer(
	t: Transfer,
	input: { orgId: string; by: string; now: number }
): TransferResult {
	const answer = answerProposal(t, input);
	if (!answer.ok) return answer;
	return { ok: true, transfer: { ...answer.transfer, state: 'accepted' } };
}

export function declineTransfer(
	t: Transfer,
	input: { orgId: string; by: string; now: number }
): TransferResult {
	const answer = answerProposal(t, input);
	if (!answer.ok) return answer;
	return { ok: true, transfer: { ...answer.transfer, state: 'declined' } };
}

// the proposer may withdraw only while the receiving side has not answered
export function cancelTransfer(
	t: Transfer,
	input: { orgId: string; by: string; now: number }
): TransferResult {
	if (input.orgId === t.toOrgId) return fail('wrong_side');
	if (input.orgId !== t.fromOrgId) return fail('not_party');
	if (t.state !== 'proposed') return fail('not_proposed');
	if (input.now >= t.expiresAt) return fail('expired');
	return {
		ok: true,
		transfer: { ...t, state: 'cancelled', decidedBy: input.by, decidedAt: input.now }
	};
}

// the move starts only after both sides said yes, and it finishes once; an accepted transfer does
// not expire because the decision is already on record
export function completeTransfer(t: Transfer, input: { now: number }): TransferResult {
	if (t.state !== 'accepted') return fail('not_accepted');
	return {
		ok: true,
		transfer: { ...t, state: 'completed', decidedAt: t.decidedAt ?? input.now }
	};
}
