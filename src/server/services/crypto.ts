import { sha256Hex, toBase64Url, utf8 } from '@contracts/common';

export { sha256Hex };

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
