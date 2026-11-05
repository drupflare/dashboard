import { describe, expect, it } from 'vitest';
import { generateSigningKey, newId, publicKeyDigest } from '../../../contracts/src/common';
import {
	ASSERTION_CONTEXT,
	ASSERTION_SKEW_MS,
	DEFAULT_ASSERTION_TTL_MS,
	MAX_ASSERTION_TTL_MS,
	assertionSchema,
	isReplayed,
	signAssertion,
	verifyAssertion,
	type AssertionScope
} from '../../../contracts/src/owner-assertion';
import { loadVectors, vectorTests } from './vectors';

const scope = {
	siteId: newId('site'),
	opId: newId('op'),
	action: 'retire'
} as AssertionScope;

describe('signAssertion', () => {
	it('signs a 60 second assertion that passes its schema and names the pinned key', async () => {
		const key = await generateSigningKey();
		const assertion = await signAssertion(scope, 1000, key);
		expect(assertionSchema.parse(assertion)).toEqual(assertion);
		expect(assertion.exp - assertion.iat).toBe(DEFAULT_ASSERTION_TTL_MS);
		expect(assertion.kid).toBe(await publicKeyDigest(key.publicKey));
	});

	it('gives each assertion a fresh replay id unless one is passed', async () => {
		const key = await generateSigningKey();
		const a = await signAssertion(scope, 1, key);
		const b = await signAssertion(scope, 1, key);
		expect(a.id).not.toBe(b.id);
		expect((await signAssertion(scope, 1, key, { id: 'fixed-replay-id-001' })).id).toBe(
			'fixed-replay-id-001'
		);
	});

	it('rejects a short replay id, a bad kid and a missing scope field in the schema', async () => {
		const key = await generateSigningKey();
		const assertion = await signAssertion(scope, 1, key);
		expect(assertionSchema.safeParse({ ...assertion, id: 'short' }).success).toBe(false);
		expect(assertionSchema.safeParse({ ...assertion, kid: 'nope' }).success).toBe(false);
		expect(
			assertionSchema.safeParse({ ...assertion, scope: { siteId: scope.siteId } }).success
		).toBe(false);
	});
});

describe('verifyAssertion', () => {
	const setup = async () => {
		const key = await generateSigningKey();
		const assertion = await signAssertion(scope, 100_000, key);
		const options = { pinnedPublicKey: key.publicKey, now: 100_000, expect: scope };
		return { key, assertion, options };
	};

	it('accepts a valid assertion for the expected scope', async () => {
		const { assertion, options } = await setup();
		expect(await verifyAssertion(assertion, options)).toEqual({ ok: true, value: assertion });
	});

	it('accepts one at the edge of expiry plus skew and refuses one tick later', async () => {
		const { assertion, options } = await setup();
		const edge = assertion.exp + ASSERTION_SKEW_MS;
		expect((await verifyAssertion(assertion, { ...options, now: edge })).ok).toBe(true);
		expect(await verifyAssertion(assertion, { ...options, now: edge + 1 })).toEqual({
			ok: false,
			code: 'expired'
		});
	});

	it('refuses an assertion issued ahead of the skew', async () => {
		const { assertion, options } = await setup();
		expect(
			await verifyAssertion(assertion, {
				...options,
				now: assertion.iat - ASSERTION_SKEW_MS - 1
			})
		).toEqual({ ok: false, code: 'not_yet_valid' });
	});

	it('refuses a replayed id and passes an unseen one', async () => {
		const { assertion, options } = await setup();
		expect(isReplayed(assertion.id, new Set([assertion.id]))).toBe(true);
		expect(isReplayed(assertion.id, new Set())).toBe(false);
		expect(
			await verifyAssertion(assertion, { ...options, seen: new Set([assertion.id]) })
		).toEqual({
			ok: false,
			code: 'replayed'
		});
		expect((await verifyAssertion(assertion, { ...options, seen: new Set(['x']) })).ok).toBe(
			true
		);
	});

	it('refuses each scope field that differs from what the site expects', async () => {
		const { assertion, options } = await setup();
		for (const expectScope of [
			{ ...scope, siteId: newId('site') },
			{ ...scope, opId: newId('op') },
			{ ...scope, action: 'purge' }
		] as AssertionScope[]) {
			expect(await verifyAssertion(assertion, { ...options, expect: expectScope })).toEqual({
				ok: false,
				code: 'wrong_scope'
			});
		}
	});

	it('refuses a key the site did not pin and a signature from another key', async () => {
		const { assertion, options } = await setup();
		const other = await generateSigningKey();
		expect(
			await verifyAssertion(assertion, { ...options, pinnedPublicKey: other.publicKey })
		).toEqual({
			ok: false,
			code: 'key_mismatch'
		});
		const forged = { ...assertion, sig: (await signAssertion(scope, 100_000, other)).sig };
		expect(await verifyAssertion(forged, options)).toEqual({
			ok: false,
			code: 'bad_signature'
		});
	});

	it('refuses a changed scope or expiry, because the signature covers them', async () => {
		const { assertion, options } = await setup();
		const widened = { ...assertion, exp: assertion.exp + 1 };
		expect(await verifyAssertion(widened, options)).toEqual({
			ok: false,
			code: 'bad_signature'
		});
		const rescoped = { ...assertion, scope: { ...scope, action: 'purge' } };
		expect(
			await verifyAssertion(rescoped, { ...options, expect: { ...scope, action: 'purge' } })
		).toEqual({ ok: false, code: 'bad_signature' });
	});

	it('refuses a lifetime past the cap even with a good signature', async () => {
		const { key, options } = await setup();
		const long = await signAssertion(scope, 100_000, key, { ttlMs: MAX_ASSERTION_TTL_MS + 1 });
		expect(await verifyAssertion(long, options)).toEqual({ ok: false, code: 'ttl_too_long' });
		const atCap = await signAssertion(scope, 100_000, key, { ttlMs: MAX_ASSERTION_TTL_MS });
		expect((await verifyAssertion(atCap, options)).ok).toBe(true);
	});

	it('refuses malformed input and a different major version', async () => {
		const { assertion, options } = await setup();
		for (const raw of [null, 'x', [], {}, { v: 1 }]) {
			expect(await verifyAssertion(raw, options)).toEqual({ ok: false, code: 'malformed' });
		}
		expect(await verifyAssertion({ ...assertion, v: 2 }, options)).toEqual({
			ok: false,
			code: 'unsupported_version'
		});
	});
});

vectorTests('owner-assertion', { assertion: ASSERTION_CONTEXT });

describe('owner-assertion vector coverage', () => {
	it('covers every refusal the plan names', () => {
		const names = loadVectors('owner-assertion').negative.map((c) => c.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'tampered-scope',
				'expired',
				'replayed-id',
				'wrong-version',
				'pinned-key-mismatch',
				'wrong-site',
				'signed-over-written-order'
			])
		);
		expect(loadVectors('owner-assertion').positive.map((c) => c.name)).toContain(
			'reordered-fields-verify'
		);
	});
});
