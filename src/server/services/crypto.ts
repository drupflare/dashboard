import { fromBase64Url, sha256Hex, toBase64Url, utf8 } from '@contracts/common';
import { z } from 'zod';

export { sha256Hex };

// #region errors

export type CryptoErrorCode =
	'no_keys' | 'bad_key' | 'key_version_missing' | 'bad_record' | 'decrypt_failed';

export class CryptoError extends Error {
	readonly code: CryptoErrorCode;
	readonly version?: number;

	constructor(code: CryptoErrorCode, message: string, version?: number) {
		super(message);
		this.name = 'CryptoError';
		this.code = code;
		this.version = version;
	}
}

// #endregion

// #region key ring

export interface KeyRing {
	current: number;
	keys: ReadonlyMap<number, CryptoKey>;
}

const KEK_BYTES = 32;

// reads `<prefix><version>` entries, each a base64url 32-byte key; the highest version wraps new keys
export async function loadKeyRing(
	secrets: Readonly<Record<string, string | undefined>>,
	prefix = 'KEK_V'
): Promise<KeyRing> {
	const keys = new Map<number, CryptoKey>();
	for (const [name, value] of Object.entries(secrets)) {
		if (!name.startsWith(prefix) || value === undefined) continue;
		const digits = name.slice(prefix.length);
		if (!/^[1-9][0-9]{0,8}$/.test(digits)) continue;
		const version = Number(digits);
		let raw: Uint8Array;
		try {
			raw = fromBase64Url(value);
		} catch {
			throw new CryptoError('bad_key', `${name} is not base64url`, version);
		}
		if (raw.length !== KEK_BYTES) {
			throw new CryptoError('bad_key', `${name} must decode to ${KEK_BYTES} bytes`, version);
		}
		keys.set(
			version,
			await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, 'AES-GCM', false, [
				'encrypt',
				'decrypt'
			])
		);
	}
	if (keys.size === 0) throw new CryptoError('no_keys', `no ${prefix}<n> secrets were provided`);
	return { current: Math.max(...keys.keys()), keys };
}

function kekFor(ring: KeyRing, version: number): CryptoKey {
	const key = ring.keys.get(version);
	if (!key) {
		throw new CryptoError(
			'key_version_missing',
			`key version ${version} is not in the ring`,
			version
		);
	}
	return key;
}

// #endregion

// #region envelope

export interface Aad {
	siteId: string;
	purpose: string;
}

export const envelopeSchema = z.object({
	v: z.literal(1),
	kv: z.int().positive(),
	wk: z.string().regex(/^[A-Za-z0-9_-]{80}$/),
	iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
	ct: z.string().regex(/^[A-Za-z0-9_-]{22,}$/)
});

export type Envelope = z.infer<typeof envelopeSchema>;

const IV_BYTES = 12;

function payloadAad(aad: Aad): Uint8Array<ArrayBuffer> {
	return utf8(JSON.stringify(['drupflare.envelope.v1', aad.siteId, aad.purpose]));
}

function wrapAad(version: number): Uint8Array<ArrayBuffer> {
	return utf8(`drupflare.wrap.v1:${version}`);
}

function parseEnvelope(record: unknown): Envelope {
	const parsed = envelopeSchema.safeParse(record);
	if (!parsed.success) throw new CryptoError('bad_record', 'the record is not a v1 envelope');
	return parsed.data;
}

async function wrapDataKey(
	dataKey: Uint8Array<ArrayBuffer>,
	ring: KeyRing,
	version: number
): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const wrapped = new Uint8Array(
		await crypto.subtle.encrypt(
			{ name: 'AES-GCM', iv, additionalData: wrapAad(version) },
			kekFor(ring, version),
			dataKey
		)
	);
	const out = new Uint8Array(IV_BYTES + wrapped.length);
	out.set(iv);
	out.set(wrapped, IV_BYTES);
	return toBase64Url(out);
}

async function unwrapDataKey(record: Envelope, ring: KeyRing): Promise<Uint8Array<ArrayBuffer>> {
	const key = kekFor(ring, record.kv);
	const bytes = fromBase64Url(record.wk);
	try {
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: bytes.slice(0, IV_BYTES),
					additionalData: wrapAad(record.kv)
				},
				key,
				bytes.slice(IV_BYTES)
			)
		);
	} catch {
		throw new CryptoError('decrypt_failed', 'the wrapped data key failed authentication');
	}
}

export async function encryptRecord(
	plaintext: string | Uint8Array,
	aad: Aad,
	ring: KeyRing
): Promise<Envelope> {
	const dataKey = crypto.getRandomValues(new Uint8Array(32));
	try {
		const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
		const key = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['encrypt']);
		const data = typeof plaintext === 'string' ? utf8(plaintext) : new Uint8Array(plaintext);
		const ct = new Uint8Array(
			await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv, additionalData: payloadAad(aad) },
				key,
				data
			)
		);
		return {
			v: 1,
			kv: ring.current,
			wk: await wrapDataKey(dataKey, ring, ring.current),
			iv: toBase64Url(iv),
			ct: toBase64Url(ct)
		};
	} finally {
		dataKey.fill(0);
	}
}

export async function decryptRecord(
	record: unknown,
	aad: Aad,
	ring: KeyRing
): Promise<Uint8Array<ArrayBuffer>> {
	const envelope = parseEnvelope(record);
	const dataKey = await unwrapDataKey(envelope, ring);
	try {
		const key = await crypto.subtle.importKey('raw', dataKey, 'AES-GCM', false, ['decrypt']);
		return new Uint8Array(
			await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: fromBase64Url(envelope.iv),
					additionalData: payloadAad(aad)
				},
				key,
				fromBase64Url(envelope.ct)
			)
		);
	} catch (error) {
		if (error instanceof CryptoError) throw error;
		throw new CryptoError('decrypt_failed', 'the record failed authentication');
	} finally {
		dataKey.fill(0);
	}
}

export async function decryptRecordText(record: unknown, aad: Aad, ring: KeyRing): Promise<string> {
	return new TextDecoder().decode(await decryptRecord(record, aad, ring));
}

// moves the wrapped data key to the newest version; iv and ciphertext stay as they were
export async function rewrap(record: unknown, ring: KeyRing): Promise<Envelope> {
	const envelope = parseEnvelope(record);
	if (envelope.kv === ring.current) return envelope;
	const dataKey = await unwrapDataKey(envelope, ring);
	try {
		return {
			...envelope,
			kv: ring.current,
			wk: await wrapDataKey(dataKey, ring, ring.current)
		};
	} finally {
		dataKey.fill(0);
	}
}

// #endregion

// #region helpers

// walks the longer input in full and folds the length difference in, so the loop never exits early
export function timingSafeEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
	const left = typeof a === 'string' ? utf8(a) : a;
	const right = typeof b === 'string' ? utf8(b) : b;
	let diff = left.length ^ right.length;
	const length = Math.max(left.length, right.length);
	for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
	return diff === 0;
}

export function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Base64Url(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
	return toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

async function hmacSha256(
	key: string | Uint8Array,
	data: string | Uint8Array
): Promise<Uint8Array> {
	const keyBytes = typeof key === 'string' ? utf8(key) : new Uint8Array(key);
	const dataBytes = typeof data === 'string' ? utf8(data) : new Uint8Array(data);
	const imported = await crypto.subtle.importKey(
		'raw',
		keyBytes,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	return new Uint8Array(await crypto.subtle.sign('HMAC', imported, dataBytes));
}

export async function hmacSha256Hex(
	key: string | Uint8Array,
	data: string | Uint8Array
): Promise<string> {
	return toHex(await hmacSha256(key, data));
}

export async function hmacSha256Base64Url(
	key: string | Uint8Array,
	data: string | Uint8Array
): Promise<string> {
	return toBase64Url(await hmacSha256(key, data));
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(length));
}

// 32 bytes is 256 bits, which is what a session token or api key secret needs
export function randomToken(bytes = 32): string {
	return toBase64Url(randomBytes(bytes));
}

// #endregion
