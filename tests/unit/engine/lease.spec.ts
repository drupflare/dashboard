import { describe, expect, it } from 'vitest';
import {
	acquire,
	check,
	EMPTY_LEASE,
	heartbeat,
	LEASE_REFUSALS,
	release,
	type LeaseRefusal,
	type LeaseState
} from '../../../engine/src/lease';

const NOW = 1_790_000_000_000;
const TTL = 60_000;

function held(holder = 'op_a', purpose = 'site.upgrade', now = NOW): LeaseState {
	return acquire(EMPTY_LEASE, { holder, purpose, ttlMs: TTL, now }).state;
}

const seen = new Set<LeaseRefusal>();
function code(result: { ok: boolean; code?: LeaseRefusal }): LeaseRefusal | undefined {
	if (!result.ok && result.code) seen.add(result.code);
	return result.ok ? undefined : result.code;
}

describe('acquire', () => {
	it('grants the first holder epoch 1 with a time limit', () => {
		const { state, result } = acquire(EMPTY_LEASE, {
			holder: 'op_a',
			purpose: 'site.upgrade',
			ttlMs: TTL,
			now: NOW
		});
		expect(result).toEqual({ ok: true, epoch: 1, expiresAt: NOW + TTL });
		expect(state.holder).toEqual({ id: 'op_a', purpose: 'site.upgrade', expiresAt: NOW + TTL });
	});

	it('refuses a second acquirer until the first expires, whatever its purpose', () => {
		const state = held('op_repair', 'repair.run');
		const rollout = acquire(state, {
			holder: 'op_rollout',
			purpose: 'fleet.upgrade',
			ttlMs: TTL,
			now: NOW + 1
		});
		expect(code(rollout.result)).toBe('held');
		expect(rollout.result).toMatchObject({ heldBy: 'op_repair', until: NOW + TTL });
		expect(rollout.state).toBe(state);
		const justBefore = acquire(state, {
			holder: 'op_rollout',
			purpose: 'fleet.upgrade',
			ttlMs: TTL,
			now: NOW + TTL - 1
		});
		expect(code(justBefore.result)).toBe('held');
	});

	it('hands the site to the next acquirer at the expiry, with a higher epoch', () => {
		const state = held('op_repair', 'repair.run');
		const next = acquire(state, {
			holder: 'op_rollout',
			purpose: 'fleet.upgrade',
			ttlMs: TTL,
			now: NOW + TTL
		});
		expect(next.result).toEqual({ ok: true, epoch: 2, expiresAt: NOW + 2 * TTL });
		expect(next.state.holder?.id).toBe('op_rollout');
	});

	it('keeps the epoch and extends the time when the holder asks again', () => {
		const state = held();
		const again = acquire(state, {
			holder: 'op_a',
			purpose: 'site.upgrade',
			ttlMs: TTL,
			now: NOW + 10_000
		});
		expect(again.result).toEqual({ ok: true, epoch: 1, expiresAt: NOW + 10_000 + TTL });
	});

	it('keeps counting epochs across a release', () => {
		let state = held();
		state = release(state, { holder: 'op_a', epoch: 1, now: NOW }).state;
		const next = acquire(state, { holder: 'op_b', purpose: 'x', ttlMs: TTL, now: NOW });
		expect(next.result).toMatchObject({ ok: true, epoch: 2 });
	});
});

describe('check and heartbeat', () => {
	it('accepts the live holder at its epoch', () => {
		expect(check(held(), { holder: 'op_a', epoch: 1, now: NOW + 1 })).toMatchObject({
			ok: true
		});
	});

	it('rejects a write from a holder whose time ran out, even when nobody else took over', () => {
		expect(code(check(held(), { holder: 'op_a', epoch: 1, now: NOW + TTL }))).toBe('expired');
	});

	it('rejects a write from an old epoch once another holder has the site', () => {
		const taken = acquire(held(), {
			holder: 'op_b',
			purpose: 'repair.run',
			ttlMs: TTL,
			now: NOW + TTL
		}).state;
		expect(code(check(taken, { holder: 'op_a', epoch: 1, now: NOW + TTL + 1 }))).toBe(
			'stale_epoch'
		);
		expect(
			code(check(taken, { holder: 'op_b', epoch: 2, now: NOW + TTL + 1 }))
		).toBeUndefined();
	});

	it('rejects a holder that is not the one on record at the current epoch', () => {
		expect(code(check(held(), { holder: 'op_b', epoch: 1, now: NOW + 1 }))).toBe('not_holder');
		expect(code(check(EMPTY_LEASE, { holder: 'op_a', epoch: 0, now: NOW }))).toBe('not_holder');
	});

	it('extends a live lease and refuses an expired or foreign one', () => {
		const state = held();
		const beat = heartbeat(state, { holder: 'op_a', epoch: 1, ttlMs: TTL, now: NOW + 30_000 });
		expect(beat.result).toEqual({ ok: true, epoch: 1, expiresAt: NOW + 30_000 + TTL });
		expect(beat.state.holder?.expiresAt).toBe(NOW + 30_000 + TTL);
		const late = heartbeat(state, { holder: 'op_a', epoch: 1, ttlMs: TTL, now: NOW + TTL });
		expect(code(late.result)).toBe('expired');
		expect(late.state).toBe(state);
		const foreign = heartbeat(state, { holder: 'op_b', epoch: 1, ttlMs: TTL, now: NOW + 1 });
		expect(code(foreign.result)).toBe('not_holder');
	});
});

describe('release', () => {
	it('frees the site and is harmless to repeat', () => {
		const first = release(held(), { holder: 'op_a', epoch: 1, now: NOW });
		expect(first.result).toEqual({ ok: true });
		expect(first.state.holder).toBeNull();
		const second = release(first.state, { holder: 'op_a', epoch: 1, now: NOW });
		expect(second.result).toEqual({ ok: true });
	});

	it('never frees what another holder took, and refuses a foreign holder', () => {
		const taken = acquire(held(), {
			holder: 'op_b',
			purpose: 'repair.run',
			ttlMs: TTL,
			now: NOW + TTL
		}).state;
		const stale = release(taken, { holder: 'op_a', epoch: 1, now: NOW + TTL });
		expect(code(stale.result)).toBe('stale_epoch');
		expect(stale.state.holder?.id).toBe('op_b');
		const foreign = release(taken, { holder: 'op_a', epoch: 2, now: NOW + TTL });
		expect(code(foreign.result)).toBe('not_holder');
		expect(foreign.state.holder?.id).toBe('op_b');
	});
});

describe('typed refusals', () => {
	it('has tripped every refusal the lease can give', () => {
		expect([...seen].sort()).toEqual([...LEASE_REFUSALS].sort());
	});
});
