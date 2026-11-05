import { describe, expect, it } from 'vitest';
import { generateSigningKey, newId, sha256Digest } from '../../../contracts/src/common';
import {
	DEFAULT_CLOCK_SKEW_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_STALE_GRACE_MS,
	LEASE_CONTEXT,
	LEASE_STATES,
	RISK_CLASSES,
	SECURITY_STATES,
	STRICT_LEASE_MS,
	authorityStateSchema,
	checkLease,
	decideRenewal,
	isReusable,
	isSecurityState,
	issueLease,
	leaseSchema,
	modeForRisk,
	needsRenewal,
	renewalRequestSchema,
	renewalResponseSchema,
	type AuthorityState
} from '../../../contracts/src/site-auth';
import { loadVectors, vectorTests } from './vectors';

const site = newId('site') as AuthorityState['siteId'];

async function authority(patch: Partial<AuthorityState> = {}): Promise<AuthorityState> {
	return {
		siteId: site,
		epoch: 2,
		generation: 5,
		state: 'active',
		risk: 'established',
		limits: { viewsPerMonth: 1000 },
		accessRuleHash: await sha256Digest('rules'),
		...patch
	};
}

describe('site-auth schemas', () => {
	it('round-trips authority state, a lease, a renewal request and both renewal responses', async () => {
		const key = await generateSigningKey();
		const state = await authority();
		expect(authorityStateSchema.parse(state)).toEqual(state);
		const lease = await issueLease(state, 1000, key.privateKey);
		expect(leaseSchema.parse(lease)).toEqual(lease);
		const request = { v: 1, siteId: site, epoch: 2, generation: 5 };
		expect(renewalRequestSchema.parse(request)).toEqual(request);
		expect(renewalResponseSchema.parse({ ok: true, lease })).toEqual({ ok: true, lease });
		expect(renewalResponseSchema.parse({ ok: false, code: 'revoked' })).toEqual({
			ok: false,
			code: 'revoked'
		});
	});

	it('rejects an unknown state, a negative limit, an expiry before issue and an unknown refusal', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority(), 1000, key.privateKey);
		expect(leaseSchema.safeParse({ ...lease, state: 'deleted' }).success).toBe(false);
		expect(leaseSchema.safeParse({ ...lease, limits: { a: -1 } }).success).toBe(false);
		expect(leaseSchema.safeParse({ ...lease, exp: lease.iat }).success).toBe(false);
		expect(leaseSchema.safeParse({ ...lease, v: 2 }).success).toBe(false);
		expect(renewalResponseSchema.safeParse({ ok: false, code: 'whatever' }).success).toBe(
			false
		);
	});
});

describe('modes', () => {
	it('puts only established sites on a reusable lease', () => {
		for (const risk of RISK_CLASSES) {
			expect(modeForRisk(risk)).toBe(risk === 'established' ? 'lease' : 'strict');
		}
	});

	it('gives a lease mode the default life and a strict lease the short one', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority(), 1000, key.privateKey);
		const strict = await issueLease(
			await authority({ risk: 'abuse-watch' }),
			1000,
			key.privateKey
		);
		expect(lease.exp - lease.iat).toBe(DEFAULT_LEASE_MS);
		expect(strict.exp - strict.iat).toBe(STRICT_LEASE_MS);
		expect(isReusable(lease)).toBe(true);
		expect(isReusable(strict)).toBe(false);
		const custom = await issueLease(await authority(), 1000, key.privateKey, { leaseMs: 9000 });
		expect(custom.exp - custom.iat).toBe(9000);
	});

	it('marks suspended and revoked as security states', () => {
		expect(SECURITY_STATES).toEqual(['suspended', 'revoked']);
		for (const state of LEASE_STATES) {
			expect(isSecurityState(state)).toBe(state === 'suspended' || state === 'revoked');
		}
	});
});

describe('renewal', () => {
	it('asks for renewal with about a third of the life left, for reusable leases only', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority(), 0, key.privateKey);
		expect(needsRenewal(lease, 0)).toBe(false);
		expect(needsRenewal(lease, 19_999)).toBe(false);
		expect(needsRenewal(lease, 20_000)).toBe(true);
		expect(needsRenewal(lease, 40_000)).toBe(true);
		const strict = await issueLease(await authority({ risk: 'new-free' }), 0, key.privateKey);
		expect(needsRenewal(strict, strict.exp)).toBe(false);
	});

	it('refuses renewal for a revoked site, a wrong epoch and a wrong site', async () => {
		const state = await authority();
		expect(decideRenewal({ siteId: site, epoch: 2 }, state)).toEqual({ ok: true });
		expect(decideRenewal({ siteId: site, epoch: 2 }, { ...state, state: 'revoked' })).toEqual({
			ok: false,
			code: 'revoked'
		});
		expect(decideRenewal({ siteId: site, epoch: 1 }, state)).toEqual({
			ok: false,
			code: 'wrong_epoch'
		});
		expect(decideRenewal({ siteId: newId('site') as typeof site, epoch: 2 }, state)).toEqual({
			ok: false,
			code: 'wrong_site'
		});
	});

	it('renews a suspended site, because only revocation is refused', async () => {
		const state = await authority({ state: 'suspended' });
		expect(decideRenewal({ siteId: site, epoch: 2 }, state)).toEqual({ ok: true });
	});
});

describe('checkLease', () => {
	const base = (publicKey: string, now: number) => ({
		publicKey,
		now,
		siteId: site as string,
		epoch: 2
	});

	it('serves inside the life and through the clock skew, then stops', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority(), 0, key.privateKey);
		const at = (now: number) => checkLease(lease, base(key.publicKey, now));
		expect((await at(lease.exp)).ok).toBe(true);
		expect((await at(lease.exp + DEFAULT_CLOCK_SKEW_MS)).ok).toBe(true);
		expect(await at(lease.exp + DEFAULT_CLOCK_SKEW_MS + 1)).toEqual({
			ok: false,
			code: 'expired'
		});
	});

	it('honours a custom skew', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority(), 0, key.privateKey);
		expect(
			await checkLease(lease, { ...base(key.publicKey, lease.exp + 1), skewMs: 0 })
		).toEqual({ ok: false, code: 'expired' });
	});

	it('rides the stale grace for non-security states only after a renewal failure', async () => {
		const key = await generateSigningKey();
		for (const state of ['active', 'plan-grace'] as const) {
			const lease = await issueLease(await authority({ state }), 0, key.privateKey);
			const now = lease.exp + DEFAULT_CLOCK_SKEW_MS + 1000;
			const noFailure = await checkLease(lease, base(key.publicKey, now));
			expect(noFailure).toEqual({ ok: false, code: 'expired' });
			const failure = await checkLease(lease, {
				...base(key.publicKey, now),
				renewalFailed: true
			});
			expect(failure.ok && failure.value.serving).toBe('availability-grace');
			const late = lease.exp + DEFAULT_CLOCK_SKEW_MS + DEFAULT_STALE_GRACE_MS + 1;
			expect(
				await checkLease(lease, { ...base(key.publicKey, late), renewalFailed: true })
			).toEqual({ ok: false, code: 'expired' });
		}
	});

	it('never gives grace to a security state, even inside the grace window', async () => {
		const key = await generateSigningKey();
		for (const state of ['suspended', 'revoked'] as const) {
			const lease = await issueLease(await authority({ state }), 0, key.privateKey);
			const result = await checkLease(lease, {
				...base(key.publicKey, lease.exp + 1000),
				renewalFailed: true
			});
			expect(result).toEqual({ ok: false, code: state });
			const fresh = await checkLease(lease, base(key.publicKey, 1));
			expect(fresh).toEqual({ ok: false, code: state });
		}
	});

	it('never gives grace to a strict lease', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority({ risk: 'escalated' }), 0, key.privateKey);
		const result = await checkLease(lease, {
			...base(key.publicKey, lease.exp + 1000 + DEFAULT_CLOCK_SKEW_MS),
			renewalFailed: true
		});
		expect(result).toEqual({ ok: false, code: 'expired' });
		const live = await checkLease(lease, base(key.publicKey, 1));
		expect(live.ok && live.value.serving).toBe('strict');
	});

	it('refuses a lease for another site or an older epoch', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority(), 0, key.privateKey);
		expect(
			await checkLease(lease, { ...base(key.publicKey, 1), siteId: newId('site') })
		).toEqual({
			ok: false,
			code: 'wrong_site'
		});
		expect(await checkLease(lease, { ...base(key.publicKey, 1), epoch: 3 })).toEqual({
			ok: false,
			code: 'wrong_epoch'
		});
		expect(await checkLease(lease, { ...base(key.publicKey, 1), epoch: 1 })).toEqual({
			ok: false,
			code: 'wrong_epoch'
		});
	});

	it('checks the signature before the site, so an unsigned edit learns nothing', async () => {
		const key = await generateSigningKey();
		const lease = await issueLease(await authority(), 0, key.privateKey);
		const result = await checkLease(
			{ ...lease, epoch: 9 },
			{ ...base(key.publicKey, 1), siteId: newId('site') }
		);
		expect(result).toEqual({ ok: false, code: 'bad_signature' });
	});

	it('refuses malformed input and a lease signed under another context', async () => {
		const key = await generateSigningKey();
		for (const raw of [null, 'x', [], {}, { v: 1 }]) {
			expect(await checkLease(raw, base(key.publicKey, 1))).toEqual({
				ok: false,
				code: 'malformed'
			});
		}
		const lease = await issueLease(await authority(), 0, key.privateKey);
		const { sig: _sig, ...body } = lease;
		const sig = await crypto.subtle.sign(
			'Ed25519',
			key.privateKey,
			new TextEncoder().encode(`drupflare.other\n${JSON.stringify(body)}`)
		);
		expect(LEASE_CONTEXT).toBe('drupflare.site-auth.lease.v1');
		const forged = { ...body, sig: Buffer.from(sig).toString('base64url') };
		expect(await checkLease(forged, base(key.publicKey, 1))).toEqual({
			ok: false,
			code: 'bad_signature'
		});
	});
});

vectorTests('site-auth', { lease: LEASE_CONTEXT });

describe('site-auth vector coverage', () => {
	it('covers every refusal the plan names', () => {
		const names = loadVectors('site-auth').negative.map((c) => c.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'tampered-state',
				'expired',
				'wrong-epoch',
				'wrong-version',
				'revoked-state',
				'security-state-gets-no-grace',
				'strict-has-no-grace',
				'signed-over-written-order'
			])
		);
		const positives = loadVectors('site-auth').positive.map((c) => c.name);
		expect(positives).toEqual(
			expect.arrayContaining([
				'lease-mode',
				'strict-mode',
				'availability-grace',
				'reordered-fields-verify'
			])
		);
	});
});
