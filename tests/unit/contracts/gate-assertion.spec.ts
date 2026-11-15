import { describe, expect, it } from 'vitest';
import { generateSigningKey, newId } from '../../../contracts/src/common';
import {
	DEFAULT_GATE_TTL_MS,
	GATE_CONTEXT,
	GATE_SKEW_MS,
	MAX_GATE_TTL_MS,
	gateAssertionSchema,
	signGateAssertion,
	verifyGateAssertion
} from '../../../contracts/src/gate-assertion';
import { vectorTests } from './vectors';

const claim = {
	siteId: newId('site'),
	environment: 'staging',
	ruleHash: `sha256:${'a'.repeat(64)}`,
	sub: 'visitor-1'
};

const setup = async () => {
	const key = await generateSigningKey();
	const assertion = await signGateAssertion(claim, 100_000, key);
	const options = {
		publicKey: key.publicKey,
		now: 100_000,
		siteId: claim.siteId,
		environment: claim.environment,
		ruleHash: claim.ruleHash
	};
	return { key, assertion, options };
};

describe('signGateAssertion', () => {
	it('signs a one hour assertion that passes its schema', async () => {
		const { assertion } = await setup();
		expect(gateAssertionSchema.parse(assertion)).toEqual(assertion);
		expect(assertion.exp - assertion.iat).toBe(DEFAULT_GATE_TTL_MS);
	});

	it('gives each assertion a fresh replay id unless one is passed', async () => {
		const key = await generateSigningKey();
		const a = await signGateAssertion(claim, 1, key);
		const b = await signGateAssertion(claim, 1, key);
		expect(a.id).not.toBe(b.id);
	});
});

describe('verifyGateAssertion', () => {
	it('admits a valid assertion', async () => {
		const { assertion, options } = await setup();
		expect((await verifyGateAssertion(assertion, options)).ok).toBe(true);
	});

	it('refuses non-objects, a bad shape and a wrong major version', async () => {
		const { assertion, options } = await setup();
		for (const raw of [null, 'x', [], {}]) {
			expect(await verifyGateAssertion(raw, options)).toEqual({
				ok: false,
				code: 'malformed'
			});
		}
		expect(await verifyGateAssertion({ ...assertion, v: 2 }, options)).toEqual({
			ok: false,
			code: 'unsupported_version'
		});
	});

	it('refuses a forged signature and a tampered claim', async () => {
		const { assertion, options } = await setup();
		const other = await generateSigningKey();
		expect(
			await verifyGateAssertion(assertion, { ...options, publicKey: other.publicKey })
		).toEqual({ ok: false, code: 'bad_signature' });
		expect(await verifyGateAssertion({ ...assertion, sub: 'someone' }, options)).toEqual({
			ok: false,
			code: 'bad_signature'
		});
	});

	it('refuses an expired, a future and an over-long assertion', async () => {
		const { assertion, options, key } = await setup();
		expect(
			await verifyGateAssertion(assertion, {
				...options,
				now: assertion.exp + GATE_SKEW_MS + 1
			})
		).toEqual({ ok: false, code: 'expired' });
		expect(
			await verifyGateAssertion(assertion, {
				...options,
				now: assertion.iat - GATE_SKEW_MS - 1
			})
		).toEqual({ ok: false, code: 'not_yet_valid' });
		const long = await signGateAssertion(claim, 100_000, key, { ttlMs: MAX_GATE_TTL_MS + 1 });
		expect(await verifyGateAssertion(long, options)).toEqual({
			ok: false,
			code: 'ttl_too_long'
		});
	});

	it('refuses another site, another environment and a stale rule hash', async () => {
		const { assertion, options } = await setup();
		expect(await verifyGateAssertion(assertion, { ...options, siteId: newId('site') })).toEqual(
			{ ok: false, code: 'wrong_site' }
		);
		expect(await verifyGateAssertion(assertion, { ...options, environment: 'dev' })).toEqual({
			ok: false,
			code: 'wrong_environment'
		});
		expect(
			await verifyGateAssertion(assertion, {
				...options,
				ruleHash: `sha256:${'b'.repeat(64)}`
			})
		).toEqual({ ok: false, code: 'stale_rule_hash' });
	});

	it('refuses a replayed id only when a seen set is passed', async () => {
		const { assertion, options } = await setup();
		const seen = new Set([assertion.id]);
		expect(await verifyGateAssertion(assertion, { ...options, seen })).toEqual({
			ok: false,
			code: 'replayed'
		});
		expect((await verifyGateAssertion(assertion, options)).ok).toBe(true);
	});
});

vectorTests('gate-assertion', { gate: GATE_CONTEXT });
