import { ApiError } from '../errors';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const BODY = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function newId(prefix: string): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	let value = 0;
	let bits = 0;
	let body = '';
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			body += ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) body += ALPHABET[(value << (5 - bits)) & 31];
	return `${prefix}_${body}`;
}

export function parseId(id: string, prefix: string): string {
	const head = `${prefix}_`;
	if (!id.startsWith(head) || !BODY.test(id.slice(head.length))) {
		throw new ApiError('validation', `Expected an id with the ${prefix} prefix`);
	}
	return id;
}
