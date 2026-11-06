import { describe, expect, it } from 'vitest';
import { fromBase64Url, toBase64Url } from '../../../../contracts/src/common';
import {
	CryptoError,
	decryptRecord,
	decryptRecordText,
	encryptRecord,
	loadKeyRing,
	rewrap,
	type Aad,
	type Envelope
} from '../../../../src/shared/custody/envelope';

const kek = (fill: number) => toBase64Url(new Uint8Array(32).fill(fill));
const aad: Aad = { siteId: 'site_1', purpose: 'owner-token' };

async function failure(promise: Promise<unknown>): Promise<CryptoError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(CryptoError);
		return error as CryptoError;
	}
	throw new Error('expected a CryptoError');
}

function flip(text: string, index: number): string {
	const bytes = fromBase64Url(text);
	bytes[index] = bytes[index]! ^ 1;
	return toBase64Url(bytes);
}

describe('loadKeyRing', () => {
	it('picks the highest version as current and ignores other names', async () => {
		const ring = await loadKeyRing({
			KEK_V1: kek(1),
			KEK_V3: kek(3),
			KEK_V2: kek(2),
			OTHER: 'x'
		});
		expect(ring.current).toBe(3);
		expect([...ring.keys.keys()].sort()).toEqual([1, 2, 3]);
	});

	it('reads another prefix', async () => {
		const ring = await loadKeyRing({ INTEGRATION_KEK_7: kek(1) }, 'INTEGRATION_KEK_');
		expect(ring.current).toBe(7);
	});

	it('gives no_keys when nothing matches', async () => {
		expect((await failure(loadKeyRing({ KEK_V0: kek(1), NOPE: kek(1) }))).code).toBe('no_keys');
	});

	it('gives bad_key for a wrong length and for bad base64url', async () => {
		const short = await failure(loadKeyRing({ KEK_V1: toBase64Url(new Uint8Array(16)) }));
		expect(short.code).toBe('bad_key');
		expect(short.version).toBe(1);
		expect((await failure(loadKeyRing({ KEK_V2: '***' }))).code).toBe('bad_key');
	});
});

describe('envelope encryption', () => {
	it('round-trips text and bytes', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('owner-secret', aad, ring);
		expect(await decryptRecordText(record, aad, ring)).toBe('owner-secret');
		const bytes = new Uint8Array([0, 255, 7, 9]);
		expect([
			...(await decryptRecord(await encryptRecord(bytes, aad, ring), aad, ring))
		]).toEqual([...bytes]);
		expect(await decryptRecordText(await encryptRecord('', aad, ring), aad, ring)).toBe('');
	});

	it('writes the current key version and never the plaintext', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const record = await encryptRecord('owner-secret', aad, ring);
		expect(record.kv).toBe(2);
		expect(JSON.stringify(record)).not.toContain('owner-secret');
	});

	it('uses a fresh data key and iv for each record', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const a = await encryptRecord('same', aad, ring);
		const b = await encryptRecord('same', aad, ring);
		expect(a.wk).not.toBe(b.wk);
		expect(a.iv).not.toBe(b.iv);
		expect(a.ct).not.toBe(b.ct);
	});

	it.each([
		['wk', 0],
		['wk', 40],
		['iv', 0],
		['ct', 0]
	] as const)('refuses a record with a flipped byte in %s at %i', async (field, index) => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('owner-secret', aad, ring);
		const tampered = { ...record, [field]: flip(record[field], index) };
		expect((await failure(decryptRecord(tampered, aad, ring))).code).toBe('decrypt_failed');
	});

	it('refuses the wrong associated data for a site or a purpose', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('owner-secret', aad, ring);
		expect(
			(await failure(decryptRecord(record, { ...aad, siteId: 'site_2' }, ring))).code
		).toBe('decrypt_failed');
		expect(
			(await failure(decryptRecord(record, { ...aad, purpose: 'integration' }, ring))).code
		).toBe('decrypt_failed');
	});

	it('does not let a site id and purpose trade characters', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('x', { siteId: 'a', purpose: 'b|c' }, ring);
		expect(
			(await failure(decryptRecord(record, { siteId: 'a|b', purpose: 'c' }, ring))).code
		).toBe('decrypt_failed');
	});

	it('refuses a key version that is not in the ring, with the version', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('owner-secret', aad, ring);
		const other = await loadKeyRing({ KEK_V2: kek(2) });
		const error = await failure(decryptRecord(record, aad, other));
		expect(error.code).toBe('key_version_missing');
		expect(error.version).toBe(1);
		const bumped = { ...record, kv: 9 };
		expect((await failure(decryptRecord(bumped, aad, ring))).code).toBe('key_version_missing');
	});

	it('refuses a record under the wrong key bytes for the same version', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('owner-secret', aad, ring);
		const wrong = await loadKeyRing({ KEK_V1: kek(9) });
		expect((await failure(decryptRecord(record, aad, wrong))).code).toBe('decrypt_failed');
	});

	it('gives bad_record for a malformed record', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('owner-secret', aad, ring);
		for (const bad of [null, 'text', {}, { ...record, v: 2 }, { ...record, wk: 'short' }]) {
			expect((await failure(decryptRecord(bad, aad, ring))).code).toBe('bad_record');
		}
		expect((await failure(rewrap({ ...record, kv: 0 }, ring))).code).toBe('bad_record');
	});
});

describe('rewrap', () => {
	it('moves to the newest version, keeps the plaintext and leaves iv and ciphertext alone', async () => {
		const both = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const old = await encryptRecord('owner-secret', aad, await loadKeyRing({ KEK_V1: kek(1) }));
		const moved: Envelope = await rewrap(old, both);
		expect(old.kv).toBe(1);
		expect(moved.kv).toBe(2);
		expect(moved.iv).toBe(old.iv);
		expect(moved.ct).toBe(old.ct);
		expect(moved.wk).not.toBe(old.wk);
		expect(await decryptRecordText(moved, aad, both)).toBe('owner-secret');
	});

	it('decrypts an old version until it is retired from the ring', async () => {
		const first = await loadKeyRing({ KEK_V1: kek(1) });
		const both = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const retired = await loadKeyRing({ KEK_V2: kek(2) });
		const old = await encryptRecord('owner-secret', aad, first);
		expect(await decryptRecordText(old, aad, both)).toBe('owner-secret');
		const moved = await rewrap(old, both);
		expect(await decryptRecordText(moved, aad, retired)).toBe('owner-secret');
		expect((await failure(decryptRecord(old, aad, retired))).code).toBe('key_version_missing');
	});

	it('returns a record already on the newest version unchanged', async () => {
		const ring = await loadKeyRing({ KEK_V1: kek(1) });
		const record = await encryptRecord('owner-secret', aad, ring);
		expect(await rewrap(record, ring)).toEqual(record);
	});

	it('refuses a tampered wrapped key and a version missing from the ring', async () => {
		const first = await loadKeyRing({ KEK_V1: kek(1) });
		const both = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const old = await encryptRecord('owner-secret', aad, first);
		expect((await failure(rewrap({ ...old, wk: flip(old.wk, 5) }, both))).code).toBe(
			'decrypt_failed'
		);
		const onlyNew = await loadKeyRing({ KEK_V2: kek(2) });
		expect((await failure(rewrap(old, onlyNew))).code).toBe('key_version_missing');
	});

	it('keeps the binding to the site after a rewrap', async () => {
		const both = await loadKeyRing({ KEK_V1: kek(1), KEK_V2: kek(2) });
		const old = await encryptRecord('owner-secret', aad, await loadKeyRing({ KEK_V1: kek(1) }));
		const moved = await rewrap(old, both);
		expect((await failure(decryptRecord(moved, { ...aad, siteId: 'site_2' }, both))).code).toBe(
			'decrypt_failed'
		);
	});
});
