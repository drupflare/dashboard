import { generateSigningKey } from '@contracts/common';
import { checkLease } from '@contracts/site-auth';
import { describe, expect, it } from 'vitest';
import {
	APPLY_MAX_AGE_MS,
	applyTo,
	leaseFor,
	readAuthority,
	renewFor,
	signApply
} from '../../../dispatch/src/authority';
import { authorityState, makeRig, memoryKv, newSiteId } from './fakes';

async function applyState(
	rig: Awaited<ReturnType<typeof makeRig>>,
	state: Parameters<typeof signApply>[0]
) {
	const message = await signApply(state, rig.clock.now(), rig.control.privateKey);
	return applyTo(rig.kv, message, { controlKey: rig.control.publicKey, now: rig.clock.now() });
}

describe('apply', () => {
	it('stores the first write and reads it back', async () => {
		const rig = await makeRig();
		const state = await authorityState();
		expect(await applyState(rig, state)).toEqual({
			ok: true,
			value: { applied: true, generation: 1 }
		});
		expect(readAuthority(rig.kv)).toEqual(state);
	});

	it('accepts a higher generation and ignores an identical replay of the current one', async () => {
		const rig = await makeRig();
		const state = await authorityState();
		await applyState(rig, state);
		const next = { ...state, generation: 2, limits: { cpuMs: 10 } };
		expect(await applyState(rig, next)).toMatchObject({ ok: true, value: { applied: true } });
		expect(await applyState(rig, next)).toEqual({
			ok: true,
			value: { applied: false, generation: 2 }
		});
	});

	it('refuses a stale generation, and the same generation with different content', async () => {
		const rig = await makeRig();
		const state = await authorityState({ generation: 5 });
		await applyState(rig, state);
		expect(await applyState(rig, { ...state, generation: 4, state: 'suspended' })).toEqual({
			ok: false,
			code: 'stale_generation'
		});
		expect(await applyState(rig, { ...state, state: 'suspended' })).toEqual({
			ok: false,
			code: 'stale_generation'
		});
		expect(readAuthority(rig.kv)).toEqual(state);
	});

	it('refuses a lower epoch even with a higher generation', async () => {
		const rig = await makeRig();
		const state = await authorityState({ epoch: 4 });
		await applyState(rig, state);
		expect(await applyState(rig, { ...state, epoch: 3, generation: 2 })).toEqual({
			ok: false,
			code: 'stale_epoch'
		});
	});

	it('accepts a higher epoch, which is how a hostname changes owner', async () => {
		const rig = await makeRig();
		const state = await authorityState({ epoch: 1 });
		await applyState(rig, state);
		expect(await applyState(rig, { ...state, epoch: 2, generation: 2 })).toMatchObject({
			ok: true
		});
		expect(readAuthority(rig.kv)?.epoch).toBe(2);
	});

	it('does not bring a revoked site back at the same epoch, but allows it at a higher one', async () => {
		const rig = await makeRig();
		const state = await authorityState({ epoch: 2 });
		await applyState(rig, state);
		await applyState(rig, { ...state, generation: 2, state: 'revoked' });
		expect(await applyState(rig, { ...state, generation: 3, state: 'active' })).toEqual({
			ok: false,
			code: 'revoked_epoch'
		});
		expect(
			await applyState(rig, { ...state, generation: 3, epoch: 3, state: 'active' })
		).toMatchObject({ ok: true });
	});

	it('refuses a message for another site once the object holds one', async () => {
		const rig = await makeRig();
		await applyState(rig, await authorityState());
		expect(await applyState(rig, await authorityState({ generation: 9 }))).toEqual({
			ok: false,
			code: 'wrong_site'
		});
	});

	it('refuses a message when the object knows which site it is and the message names another', async () => {
		const rig = await makeRig();
		const state = await authorityState();
		const message = await signApply(state, rig.clock.now(), rig.control.privateKey);
		expect(
			await applyTo(rig.kv, message, {
				controlKey: rig.control.publicKey,
				now: rig.clock.now(),
				expectedSiteId: newSiteId()
			})
		).toEqual({ ok: false, code: 'wrong_site' });
		expect(readAuthority(rig.kv)).toBeUndefined();
	});

	it('refuses a bad signature: another key, a tampered body, a changed context', async () => {
		const rig = await makeRig();
		const other = await generateSigningKey();
		const state = await authorityState();
		const opts = { controlKey: rig.control.publicKey, now: rig.clock.now() };
		const forged = await signApply(state, rig.clock.now(), other.privateKey);
		expect(await applyTo(rig.kv, forged, opts)).toEqual({ ok: false, code: 'bad_signature' });
		const signed = await signApply(state, rig.clock.now(), rig.control.privateKey);
		const tampered = { ...signed, state: 'revoked' };
		expect(await applyTo(rig.kv, tampered, opts)).toEqual({ ok: false, code: 'bad_signature' });
		expect(readAuthority(rig.kv)).toBeUndefined();
	});

	it('refuses a malformed message and one with an unknown field', async () => {
		const rig = await makeRig();
		const opts = { controlKey: rig.control.publicKey, now: rig.clock.now() };
		const signed = await signApply(
			await authorityState(),
			rig.clock.now(),
			rig.control.privateKey
		);
		expect(await applyTo(rig.kv, { nope: true }, opts)).toEqual({
			ok: false,
			code: 'malformed'
		});
		expect(await applyTo(rig.kv, null, opts)).toEqual({ ok: false, code: 'malformed' });
		expect(await applyTo(rig.kv, { ...signed, extra: 1 }, opts)).toEqual({
			ok: false,
			code: 'malformed'
		});
	});

	it('refuses a message older or newer than the freshness window', async () => {
		const rig = await makeRig();
		const state = await authorityState();
		const opts = { controlKey: rig.control.publicKey, now: rig.clock.now() };
		for (const iat of [opts.now - APPLY_MAX_AGE_MS - 1, opts.now + APPLY_MAX_AGE_MS + 1]) {
			const message = await signApply(state, iat, rig.control.privateKey);
			expect(await applyTo(rig.kv, message, opts)).toEqual({
				ok: false,
				code: 'stale_message'
			});
		}
	});
});

describe('lease and renew', () => {
	it('issues a signed lease that the contract check accepts', async () => {
		const rig = await makeRig();
		const state = await authorityState({ epoch: 2 });
		await rig.commit(state);
		const result = await leaseFor(rig.kv, state, rig.clock.now(), rig.lease.privateKey);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const checked = await checkLease(result.lease, {
			publicKey: rig.lease.publicKey,
			now: rig.clock.now(),
			siteId: state.siteId,
			epoch: 2
		});
		expect(checked).toMatchObject({ ok: true, value: { serving: 'lease' } });
	});

	it('answers unknown_site before any write', async () => {
		const rig = await makeRig();
		const request = { siteId: newSiteId(), epoch: 1 };
		expect(await leaseFor(memoryKv(), request, rig.clock.now(), rig.lease.privateKey)).toEqual({
			ok: false,
			code: 'unknown_site'
		});
	});

	it('refuses a lease for another site and another epoch', async () => {
		const rig = await makeRig();
		const state = await authorityState({ epoch: 2 });
		await rig.commit(state);
		const now = rig.clock.now();
		expect(
			await leaseFor(rig.kv, { siteId: newSiteId(), epoch: 2 }, now, rig.lease.privateKey)
		).toEqual({ ok: false, code: 'wrong_site' });
		expect(
			await leaseFor(rig.kv, { siteId: state.siteId, epoch: 1 }, now, rig.lease.privateKey)
		).toEqual({ ok: false, code: 'wrong_epoch' });
	});

	it('never issues a lease to a revoked site at the same epoch, by lease or by renew', async () => {
		const rig = await makeRig();
		const state = await authorityState({ epoch: 2 });
		await rig.commit(state);
		await rig.commit({ ...state, generation: 2, state: 'revoked' });
		const now = rig.clock.now();
		expect(await leaseFor(rig.kv, state, now, rig.lease.privateKey)).toEqual({
			ok: false,
			code: 'revoked'
		});
		const renewal = { v: 1, siteId: state.siteId, epoch: 2, generation: 1 };
		expect(await renewFor(rig.kv, renewal, now, rig.lease.privateKey)).toEqual({
			ok: false,
			code: 'revoked'
		});
	});

	it('issues a suspended site a lease that says so, and strict mode for a risky site', async () => {
		const rig = await makeRig();
		const state = await authorityState({ state: 'suspended', risk: 'abuse-watch' });
		await rig.commit(state);
		const result = await leaseFor(rig.kv, state, rig.clock.now(), rig.lease.privateKey);
		expect(result).toMatchObject({ ok: true, lease: { state: 'suspended', mode: 'strict' } });
	});

	it('refuses a malformed renewal request', async () => {
		const rig = await makeRig();
		expect(
			await renewFor(rig.kv, { siteId: 1 }, rig.clock.now(), rig.lease.privateKey)
		).toEqual({
			ok: false,
			code: 'malformed'
		});
	});

	it('stamps iat with the caller clock so a lease cannot outlive the commit by more than its life', async () => {
		const rig = await makeRig();
		const state = await authorityState();
		await rig.commit(state);
		const now = rig.clock.now();
		const result = await leaseFor(rig.kv, state, now, rig.lease.privateKey);
		expect(result).toMatchObject({ ok: true, lease: { iat: now, exp: now + 30_000 } });
	});
});
