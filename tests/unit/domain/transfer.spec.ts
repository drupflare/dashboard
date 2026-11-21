import { describe, expect, it } from 'vitest';
import {
	acceptTransfer,
	cancelTransfer,
	completeTransfer,
	declineTransfer,
	proposeTransfer,
	TRANSFER_WINDOW_MS,
	transferView,
	type Transfer
} from '../../../src/server/domain/transfer';

const NOW = 1_800_000_000_000;
const FROM = 'org-source';
const TO = 'org-target';

function proposed(over: Partial<Transfer> = {}): Transfer {
	const result = proposeTransfer({
		id: 't1',
		siteId: 'site-1',
		fromOrgId: FROM,
		toOrgId: TO,
		keepDelegationId: null,
		proposedBy: 'owner-source',
		now: NOW - 1000
	});
	if (!result.ok) throw new Error(result.reason);
	return { ...result.transfer, ...over };
}

describe('site transfer lifecycle', () => {
	it('proposes with a fourteen day window and names both sides', () => {
		const result = proposeTransfer({
			id: 't1',
			siteId: 'site-1',
			fromOrgId: FROM,
			toOrgId: TO,
			keepDelegationId: 'batch-1',
			proposedBy: 'owner-source',
			now: NOW
		});
		expect(result).toMatchObject({
			ok: true,
			transfer: {
				state: 'proposed',
				fromOrgId: FROM,
				toOrgId: TO,
				keepDelegationId: 'batch-1',
				expiresAt: NOW + TRANSFER_WINDOW_MS
			}
		});
		expect(TRANSFER_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
	});

	it('refuses a transfer to the same organisation', () => {
		const result = proposeTransfer({
			id: 't1',
			siteId: 'site-1',
			fromOrgId: FROM,
			toOrgId: FROM,
			keepDelegationId: null,
			proposedBy: 'owner-source',
			now: NOW
		});
		expect(result).toEqual({ ok: false, reason: 'same_org' });
	});

	it('lets only the receiving side accept, and records who decided', () => {
		const t = proposed();
		expect(acceptTransfer(t, { orgId: FROM, by: 'x', now: NOW })).toEqual({
			ok: false,
			reason: 'wrong_side'
		});
		expect(acceptTransfer(t, { orgId: 'org-other', by: 'x', now: NOW })).toEqual({
			ok: false,
			reason: 'not_party'
		});
		const done = acceptTransfer(t, { orgId: TO, by: 'owner-target', now: NOW });
		expect(done).toMatchObject({
			ok: true,
			transfer: { state: 'accepted', decidedBy: 'owner-target', decidedAt: NOW }
		});
	});

	it('closes the window at its last instant', () => {
		const t = proposed();
		expect(transferView(t, t.expiresAt - 1)).toBe('proposed');
		expect(transferView(t, t.expiresAt)).toBe('expired');
		expect(acceptTransfer(t, { orgId: TO, by: 'x', now: t.expiresAt })).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('declines once and never after', () => {
		const declined = declineTransfer(proposed(), { orgId: TO, by: 'x', now: NOW });
		expect(declined).toMatchObject({ ok: true, transfer: { state: 'declined' } });
		if (!declined.ok) throw new Error('unreachable');
		expect(acceptTransfer(declined.transfer, { orgId: TO, by: 'x', now: NOW })).toEqual({
			ok: false,
			reason: 'not_proposed'
		});
		expect(declineTransfer(proposed(), { orgId: FROM, by: 'x', now: NOW })).toEqual({
			ok: false,
			reason: 'wrong_side'
		});
	});

	it('lets the proposer cancel only before an answer and inside the window', () => {
		const cancelled = cancelTransfer(proposed(), { orgId: FROM, by: 'x', now: NOW });
		expect(cancelled).toMatchObject({ ok: true, transfer: { state: 'cancelled' } });
		expect(cancelTransfer(proposed(), { orgId: TO, by: 'x', now: NOW })).toEqual({
			ok: false,
			reason: 'wrong_side'
		});
		const answered = proposed({ state: 'accepted' });
		expect(cancelTransfer(answered, { orgId: FROM, by: 'x', now: NOW })).toEqual({
			ok: false,
			reason: 'not_proposed'
		});
		const t = proposed();
		expect(cancelTransfer(t, { orgId: FROM, by: 'x', now: t.expiresAt })).toEqual({
			ok: false,
			reason: 'expired'
		});
	});

	it('completes only an accepted transfer, once', () => {
		const accepted = proposed({ state: 'accepted', decidedAt: NOW - 10 });
		expect(completeTransfer(accepted, { now: NOW })).toMatchObject({
			ok: true,
			transfer: { state: 'completed', decidedAt: NOW - 10 }
		});
		expect(completeTransfer(proposed(), { now: NOW })).toEqual({
			ok: false,
			reason: 'not_accepted'
		});
		expect(completeTransfer(proposed({ state: 'completed' }), { now: NOW })).toEqual({
			ok: false,
			reason: 'not_accepted'
		});
	});

	it('keeps an accepted transfer open after its window would have closed', () => {
		const accepted = proposed({ state: 'accepted' });
		expect(transferView(accepted, accepted.expiresAt + 1)).toBe('accepted');
	});
});
