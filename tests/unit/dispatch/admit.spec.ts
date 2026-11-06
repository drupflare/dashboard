import { generateSigningKey } from '@contracts/common';
import {
	DEFAULT_CLOCK_SKEW_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_STALE_GRACE_MS,
	STRICT_LEASE_MS,
	issueLease
} from '@contracts/site-auth';
import { describe, expect, it } from 'vitest';
import { admit, afterRenewal, callLimits, type AdmitContext } from '../../../dispatch/src/admit';
import { authorityState } from './fakes';

const T0 = 1_790_000_000_000;

async function setup(patch: Parameters<typeof authorityState>[0] = {}) {
	const key = await generateSigningKey();
	const state = await authorityState(patch);
	const ctx = (now: number, over: Partial<AdmitContext> = {}): AdmitContext => ({
		publicKey: key.publicKey,
		now,
		siteId: state.siteId,
		epoch: state.epoch,
		...over
	});
	return { key, state, ctx, lease: await issueLease(state, T0, key.privateKey) };
}

describe('admit', () => {
	it('asks for a lease when nothing is cached', async () => {
		const { ctx } = await setup();
		expect(await admit(undefined, ctx(T0))).toEqual({
			action: 'renew-then-serve',
			reason: 'none'
		});
		expect(await admit(null, ctx(T0))).toEqual({ action: 'renew-then-serve', reason: 'none' });
	});

	it('serves a fresh lease-mode lease without renewing', async () => {
		const { ctx, lease } = await setup();
		const decision = await admit(lease, ctx(T0 + 1000));
		expect(decision).toMatchObject({ action: 'serve', serving: 'lease', renew: false });
	});

	it('serves and renews in the background once a third of the life remains', async () => {
		const { ctx, lease } = await setup();
		const edge = lease.exp - DEFAULT_LEASE_MS / 3;
		expect(await admit(lease, ctx(edge - 1))).toMatchObject({ action: 'serve', renew: false });
		expect(await admit(lease, ctx(edge))).toMatchObject({ action: 'serve', renew: true });
	});

	it('serves through the clock skew and asks again after it', async () => {
		const { ctx, lease } = await setup();
		expect(await admit(lease, ctx(lease.exp + DEFAULT_CLOCK_SKEW_MS))).toMatchObject({
			action: 'serve'
		});
		expect(await admit(lease, ctx(lease.exp + DEFAULT_CLOCK_SKEW_MS + 1))).toEqual({
			action: 'renew-then-serve',
			reason: 'expired'
		});
	});

	it('asks SITE_AUTH on every request in strict mode, even with a valid cached lease', async () => {
		const { key, state, ctx } = await setup({ risk: 'new-free' });
		const lease = await issueLease(state, T0, key.privateKey);
		expect(lease.mode).toBe('strict');
		expect(lease.exp - lease.iat).toBe(STRICT_LEASE_MS);
		expect(await admit(lease, ctx(T0 + 1))).toEqual({
			action: 'renew-then-serve',
			reason: 'strict'
		});
	});

	it('refuses a tampered lease with bad_signature', async () => {
		const { ctx, lease } = await setup();
		const forged = { ...lease, exp: lease.exp + 3_600_000 };
		expect(await admit(forged, ctx(T0))).toEqual({ action: 'refuse', code: 'bad_signature' });
	});

	it('refuses a malformed value and an unsupported version', async () => {
		const { ctx, lease } = await setup();
		expect(await admit('lease', ctx(T0))).toEqual({ action: 'refuse', code: 'malformed' });
		expect(await admit({ ...lease, v: 2 }, ctx(T0))).toEqual({
			action: 'refuse',
			code: 'unsupported_version'
		});
	});

	it('refuses a lease for another site', async () => {
		const { ctx, lease } = await setup();
		const other = await authorityState();
		expect(await admit(lease, ctx(T0, { siteId: other.siteId }))).toEqual({
			action: 'refuse',
			code: 'wrong_site'
		});
	});

	it('refuses a lease for an older epoch once the route moves to a newer one', async () => {
		const { ctx, lease } = await setup({ epoch: 3 });
		expect(await admit(lease, ctx(T0, { epoch: 4 }))).toEqual({
			action: 'refuse',
			code: 'wrong_epoch'
		});
	});

	it('refuses a cached suspended lease until it lapses, then asks again', async () => {
		const { ctx, lease } = await setup({ state: 'suspended' });
		expect(await admit(lease, ctx(T0 + 1000))).toEqual({ action: 'refuse', code: 'suspended' });
		expect(await admit(lease, ctx(lease.exp + DEFAULT_CLOCK_SKEW_MS + 1))).toEqual({
			action: 'renew-then-serve',
			reason: 'expired'
		});
	});

	it('refuses a cached revoked lease', async () => {
		const { ctx, lease } = await setup({ state: 'revoked' });
		expect(await admit(lease, ctx(T0 + 1000))).toEqual({ action: 'refuse', code: 'revoked' });
	});

	it('serves a plan-grace lease, which is not a security state', async () => {
		const { ctx, lease } = await setup({ state: 'plan-grace' });
		expect(await admit(lease, ctx(T0 + 1000))).toMatchObject({ action: 'serve' });
	});
});

describe('afterRenewal', () => {
	it('serves a fresh lease that verifies', async () => {
		const { ctx, lease } = await setup();
		const out = await afterRenewal({ kind: 'lease', lease }, undefined, ctx(T0));
		expect(out).toMatchObject({ action: 'serve', serving: 'lease', renew: false });
	});

	it('refuses a fresh lease that fails the check', async () => {
		const { ctx, lease } = await setup({ epoch: 2 });
		const out = await afterRenewal({ kind: 'lease', lease }, undefined, ctx(T0, { epoch: 3 }));
		expect(out).toEqual({ action: 'refuse', code: 'wrong_epoch' });
	});

	it('passes a SITE_AUTH refusal through', async () => {
		const { ctx } = await setup();
		for (const code of [
			'wrong_site',
			'wrong_epoch',
			'revoked',
			'unknown_site',
			'malformed'
		] as const) {
			expect(await afterRenewal({ kind: 'refused', code }, undefined, ctx(T0))).toEqual({
				action: 'refuse',
				code
			});
		}
	});

	it('fails closed when SITE_AUTH is unreachable and nothing is cached', async () => {
		const { ctx } = await setup();
		expect(await afterRenewal({ kind: 'unreachable' }, undefined, ctx(T0))).toEqual({
			action: 'refuse',
			code: 'unavailable'
		});
	});

	it('fails closed in strict mode even with a valid cached lease', async () => {
		const { key, state, ctx } = await setup({ risk: 'escalated' });
		const lease = await issueLease(state, T0, key.privateKey);
		expect(await afterRenewal({ kind: 'unreachable' }, lease, ctx(T0 + 1))).toEqual({
			action: 'refuse',
			code: 'unavailable'
		});
		expect(
			await afterRenewal(
				{ kind: 'unreachable' },
				lease,
				ctx(lease.exp + DEFAULT_CLOCK_SKEW_MS + 1)
			)
		).toMatchObject({ action: 'refuse' });
	});

	it('grants availability grace to an expired lease-mode lease and stops at the stale grace', async () => {
		const { ctx, lease } = await setup();
		const inside = lease.exp + DEFAULT_CLOCK_SKEW_MS + 1;
		expect(await afterRenewal({ kind: 'unreachable' }, lease, ctx(inside))).toMatchObject({
			action: 'serve',
			serving: 'availability-grace'
		});
		const edge = lease.exp + DEFAULT_CLOCK_SKEW_MS + DEFAULT_STALE_GRACE_MS;
		expect(await afterRenewal({ kind: 'unreachable' }, lease, ctx(edge))).toMatchObject({
			action: 'serve'
		});
		expect(await afterRenewal({ kind: 'unreachable' }, lease, ctx(edge + 1))).toEqual({
			action: 'refuse',
			code: 'expired'
		});
	});

	it('never grants grace to a suspended or revoked lease', async () => {
		for (const state of ['suspended', 'revoked'] as const) {
			const { ctx, lease } = await setup({ state });
			const inside = lease.exp + DEFAULT_CLOCK_SKEW_MS + 1;
			expect(await afterRenewal({ kind: 'unreachable' }, lease, ctx(inside))).toEqual({
				action: 'refuse',
				code: state
			});
		}
	});

	it('never grants grace to a lease for another epoch', async () => {
		const { ctx, lease } = await setup({ epoch: 1 });
		const inside = lease.exp + DEFAULT_CLOCK_SKEW_MS + 1;
		expect(
			await afterRenewal({ kind: 'unreachable' }, lease, ctx(inside, { epoch: 2 }))
		).toEqual({
			action: 'refuse',
			code: 'wrong_epoch'
		});
	});
});

describe('callLimits', () => {
	it('reads positive integers for the cpu and subrequest limits', () => {
		expect(callLimits({ cpuMs: 50.9, subRequests: 20, viewsPerMonth: 5 })).toEqual({
			cpuMs: 50,
			subRequests: 20
		});
	});

	it('drops missing, zero and non-finite values', () => {
		expect(callLimits({})).toEqual({});
		expect(callLimits({ cpuMs: 0, subRequests: Number.NaN })).toEqual({});
		expect(callLimits({ cpuMs: Number.POSITIVE_INFINITY })).toEqual({});
	});
});
