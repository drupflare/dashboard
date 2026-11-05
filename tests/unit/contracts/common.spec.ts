import { describe, expect, it } from 'vitest';
import {
	COMPAT_WINDOW,
	CONTRACT_HEADER,
	canonicalJson,
	compareVersions,
	digestSchema,
	errorEnvelope,
	formatContractHeader,
	formatRange,
	formatVersion,
	fromBase64Url,
	generateSigningKey,
	negotiate,
	newId,
	nodeId,
	operationId,
	orgId,
	pageSchema,
	parseContractHeader,
	parseRange,
	parseVersion,
	previousMajorInWindow,
	publicKeyDigest,
	publicKeySchema,
	sha256Digest,
	sha256Hex,
	signCanonical,
	signatureSchema,
	signingKeyFromSeed,
	siteId,
	supportedRange,
	toBase64Url,
	userId,
	utf8,
	verifyCanonical,
	versionRangeSchema,
	type SupportPolicy,
	type VersionRange
} from '../../../contracts/src/common';

describe('ids', () => {
	const cases = [
		['usr', userId],
		['org', orgId],
		['site', siteId],
		['op', operationId],
		['nod', nodeId]
	] as const;

	it.each(cases)('newId(%s) round-trips through its own schema', (prefix, schema) => {
		const id = newId(prefix);
		expect(schema.parse(id)).toBe(id);
	});

	it.each(cases)(
		'%s schema rejects other prefixes, bad characters and short bodies',
		(prefix, schema) => {
			expect(schema.safeParse(`zzz_abcdefgh12`).success).toBe(false);
			expect(schema.safeParse(`${prefix}_ABCDEFGH12`).success).toBe(false);
			expect(schema.safeParse(`${prefix}_abc`).success).toBe(false);
			expect(schema.safeParse(`${prefix}-abcdefgh12`).success).toBe(false);
		}
	);

	it('generates distinct ids', () => {
		expect(new Set(Array.from({ length: 50 }, () => newId('site'))).size).toBe(50);
	});
});

describe('envelopes', () => {
	it('round-trips the error envelope and rejects a missing requestId', () => {
		const sample = {
			code: 'nope',
			message: 'No.',
			details: { field: 'x' },
			requestId: 'req_1'
		};
		expect(errorEnvelope.parse(sample)).toEqual(sample);
		expect(errorEnvelope.safeParse({ code: 'nope', message: 'No.', details: {} }).success).toBe(
			false
		);
	});

	it('round-trips a cursor page and rejects an empty cursor string', () => {
		const schema = pageSchema(userId);
		const page = { items: [newId('usr')], nextCursor: null };
		expect(schema.parse(page)).toEqual(page);
		expect(schema.safeParse({ items: [], nextCursor: '' }).success).toBe(false);
		expect(schema.safeParse({ items: ['bad'], nextCursor: null }).success).toBe(false);
	});

	it('accepts only sha256 digests', async () => {
		expect(digestSchema.safeParse(await sha256Digest('x')).success).toBe(true);
		expect(digestSchema.safeParse('sha256:abc').success).toBe(false);
		expect(digestSchema.safeParse('md5:' + '0'.repeat(32)).success).toBe(false);
	});
});

describe('canonicalJson', () => {
	it('sorts keys at every depth and drops whitespace', () => {
		expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe(
			'{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}'
		);
	});

	it('gives one output for any key order', () => {
		expect(canonicalJson({ a: 1, b: 2, c: 3 })).toBe(canonicalJson({ c: 3, a: 1, b: 2 }));
	});

	it('keeps array order and omits undefined object values', () => {
		expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
	});

	it('escapes strings as JSON does', () => {
		expect(canonicalJson({ k: 'a"b\né' })).toBe('{"k":"a\\"b\\né"}');
	});

	it('refuses values with no canonical form', () => {
		expect(() => canonicalJson(Number.NaN)).toThrow(TypeError);
		expect(() => canonicalJson(Infinity)).toThrow(TypeError);
		expect(() => canonicalJson([undefined])).toThrow(TypeError);
		expect(() => canonicalJson(() => 1)).toThrow(TypeError);
		expect(() => canonicalJson(new Date())).toThrow(TypeError);
		expect(() => canonicalJson(1n)).toThrow(TypeError);
	});

	it('is stable under a JSON round trip', () => {
		const value = { z: [1.5, -0, 'x'], a: { b: true } };
		expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(canonicalJson(value));
	});
});

describe('base64url and digests', () => {
	it('round-trips every byte length from 0 to 40', () => {
		for (let length = 0; length <= 40; length++) {
			const bytes = crypto.getRandomValues(new Uint8Array(length));
			const text = toBase64Url(bytes);
			expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
			expect(fromBase64Url(text)).toEqual(bytes);
		}
	});

	it('matches the RFC 4648 test vectors without padding', () => {
		expect(toBase64Url(utf8('f'))).toBe('Zg');
		expect(toBase64Url(utf8('fo'))).toBe('Zm8');
		expect(toBase64Url(utf8('foobar'))).toBe('Zm9vYmFy');
		expect(toBase64Url(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
	});

	it('rejects characters outside the alphabet and impossible lengths', () => {
		expect(() => fromBase64Url('ab+/')).toThrow(TypeError);
		expect(() => fromBase64Url('abcde')).toThrow(TypeError);
		expect(() => fromBase64Url('ab=')).toThrow(TypeError);
	});

	it('hashes with sha256', async () => {
		expect(await sha256Hex('')).toBe(
			'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
		expect(await sha256Digest(utf8(''))).toBe(
			'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
		);
	});
});

describe('ed25519 helpers', () => {
	it('derives the RFC 8032 public key from the first test seed', async () => {
		const seed = new Uint8Array(
			'9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60'
				.match(/../g)!
				.map((byte) => Number.parseInt(byte, 16))
		);
		const key = await signingKeyFromSeed(seed);
		expect(
			Array.from(fromBase64Url(key.publicKey), (b) => b.toString(16).padStart(2, '0')).join(
				''
			)
		).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a');
	});

	it('signs and verifies, and the key schema accepts what it emits', async () => {
		const key = await generateSigningKey();
		const sig = await signCanonical('ctx', { a: 1, b: [2] }, key.privateKey);
		expect(signatureSchema.safeParse(sig).success).toBe(true);
		expect(publicKeySchema.safeParse(key.publicKey).success).toBe(true);
		expect(await verifyCanonical('ctx', { b: [2], a: 1 }, sig, key.publicKey)).toBe(true);
	});

	it('refuses a changed value, a changed context and a different key', async () => {
		const key = await generateSigningKey();
		const other = await generateSigningKey();
		const sig = await signCanonical('ctx', { a: 1 }, key.privateKey);
		expect(await verifyCanonical('ctx', { a: 2 }, sig, key.publicKey)).toBe(false);
		expect(await verifyCanonical('other', { a: 1 }, sig, key.publicKey)).toBe(false);
		expect(await verifyCanonical('ctx', { a: 1 }, sig, other.publicKey)).toBe(false);
	});

	it('returns false for malformed keys, signatures and values instead of throwing', async () => {
		const key = await generateSigningKey();
		const sig = await signCanonical('ctx', { a: 1 }, key.privateKey);
		expect(await verifyCanonical('ctx', { a: 1 }, sig, 'not-a-key')).toBe(false);
		expect(await verifyCanonical('ctx', { a: 1 }, '!!', key.publicKey)).toBe(false);
		expect(await verifyCanonical('ctx', { a: Number.NaN }, sig, key.publicKey)).toBe(false);
	});

	it('rejects a seed of the wrong length', async () => {
		await expect(signingKeyFromSeed(new Uint8Array(31))).rejects.toThrow(TypeError);
	});

	it('is deterministic for one seed', async () => {
		const seed = new Uint8Array(32).fill(1);
		const a = await signingKeyFromSeed(seed);
		const b = await signingKeyFromSeed(seed);
		expect(a.publicKey).toBe(b.publicKey);
		expect(await signCanonical('c', { x: 1 }, a.privateKey)).toBe(
			await signCanonical('c', { x: 1 }, b.privateKey)
		);
		expect(await publicKeyDigest(a.publicKey)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe('versions', () => {
	it('formats and parses versions and ranges', () => {
		expect(formatVersion({ major: 1, minor: 2 })).toBe('1.2');
		expect(parseVersion('1.2')).toEqual({ major: 1, minor: 2 });
		expect(parseVersion('1')).toBeNull();
		expect(parseVersion('a.b')).toBeNull();
		const range: VersionRange = { min: { major: 1, minor: 0 }, max: { major: 1, minor: 3 } };
		expect(formatRange(range)).toBe('1.0-1.3');
		expect(parseRange('1.0-1.3')).toEqual(range);
		expect(formatRange({ min: range.min, max: range.min })).toBe('1.0');
		expect(parseRange('1.0')).toEqual({ min: range.min, max: range.min });
		expect(parseRange('1.3-1.0')).toBeNull();
		expect(parseRange('1.0-1.1-1.2')).toBeNull();
		expect(versionRangeSchema.parse(range)).toEqual(range);
	});

	it('compares majors before minors', () => {
		expect(compareVersions({ major: 2, minor: 0 }, { major: 1, minor: 9 })).toBeGreaterThan(0);
		expect(compareVersions({ major: 1, minor: 2 }, { major: 1, minor: 2 })).toBe(0);
	});

	it('round-trips the contract header', () => {
		const range: VersionRange = { min: { major: 1, minor: 0 }, max: { major: 1, minor: 2 } };
		const value = formatContractHeader('fleet-link', range);
		expect(CONTRACT_HEADER).toBe('Drupflare-Contract');
		expect(value).toBe('fleet-link=1.0-1.2');
		expect(parseContractHeader(value)).toEqual({ contract: 'fleet-link', range });
		expect(parseContractHeader('fleet-link')).toBeNull();
		expect(parseContractHeader('=1.0')).toBeNull();
		expect(parseContractHeader('x=abc')).toBeNull();
	});
});

describe('negotiate', () => {
	const now = new Date('2027-01-01T00:00:00Z');
	const day = 86_400_000;
	const client = (min: string, max: string): VersionRange => parseRange(`${min}-${max}`)!;
	const single: SupportPolicy = { current: { major: 1, minor: 2 } };
	const withPrevious = (superseded: string, currentMinor: number): SupportPolicy => ({
		current: { major: 2, minor: currentMinor },
		previous: { major: 1, lastMinor: 4, supersededAt: superseded }
	});

	it('accepts the current major and picks the highest shared version', () => {
		expect(negotiate(client('1.0', '1.9'), single, { now })).toEqual({
			ok: true,
			version: { major: 1, minor: 2 }
		});
		expect(negotiate(client('1.0', '1.1'), single, { now })).toEqual({
			ok: true,
			version: { major: 1, minor: 1 }
		});
	});

	it('accepts a client on the previous major inside the window', () => {
		const policy = withPrevious(new Date(now.getTime() - 10 * day).toISOString(), 0);
		expect(previousMajorInWindow(policy, now)).toBe(true);
		expect(negotiate(client('1.0', '1.9'), policy, { now })).toEqual({
			ok: true,
			version: { major: 1, minor: 4 }
		});
	});

	it('prefers the current major when the client spans both', () => {
		const policy = withPrevious(new Date(now.getTime() - 10 * day).toISOString(), 1);
		expect(negotiate(client('1.0', '2.9'), policy, { now })).toEqual({
			ok: true,
			version: { major: 2, minor: 1 }
		});
	});

	it('keeps the previous major until both the minor count and the days have passed', () => {
		const old = new Date(now.getTime() - (COMPAT_WINDOW.days + 1) * day).toISOString();
		const recent = new Date(now.getTime() - 10 * day).toISOString();
		expect(previousMajorInWindow(withPrevious(old, COMPAT_WINDOW.minorReleases - 1), now)).toBe(
			true
		);
		expect(previousMajorInWindow(withPrevious(recent, COMPAT_WINDOW.minorReleases), now)).toBe(
			true
		);
		expect(previousMajorInWindow(withPrevious(old, COMPAT_WINDOW.minorReleases), now)).toBe(
			false
		);
	});

	it('answers 426 with the supported range outside the window', () => {
		const old = new Date(now.getTime() - 400 * day).toISOString();
		const policy = withPrevious(old, 3);
		const result = negotiate(client('1.0', '1.4'), policy, { now, requestId: 'req_9' });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(426);
		expect(errorEnvelope.safeParse(result.body).success).toBe(true);
		expect(result.body.code).toBe('contract_unsupported');
		expect(result.body.requestId).toBe('req_9');
		expect(result.body.details.supported).toEqual({
			min: { major: 2, minor: 0 },
			max: { major: 2, minor: 3 }
		});
		expect(supportedRange(policy, now)).toEqual(result.body.details.supported);
	});

	it('answers 426 for an unsupported major and for a client newer than the server', () => {
		for (const [min, max] of [
			['3.0', '3.1'],
			['0.1', '0.9'],
			['1.5', '1.9']
		] as const) {
			const result = negotiate(client(min, max), single, { now });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.status).toBe(426);
		}
	});

	it('ignores a previous entry that is not the major before the current one', () => {
		const policy: SupportPolicy = {
			current: { major: 3, minor: 0 },
			previous: { major: 1, lastMinor: 2, supersededAt: now.toISOString() }
		};
		expect(previousMajorInWindow(policy, now)).toBe(false);
		expect(negotiate(client('1.0', '1.2'), policy, { now }).ok).toBe(false);
	});
});
