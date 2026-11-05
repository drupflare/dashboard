import type { z } from 'zod';
import { ApiError } from '../../shared/errors';

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export type Page<T> = { items: T[]; nextCursor: string | null };

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function encodeCursor(value: unknown): string {
	return toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeCursor<T extends z.ZodType>(cursor: string, schema: T): z.infer<T> {
	let json: unknown;
	try {
		json = JSON.parse(new TextDecoder().decode(fromBase64Url(cursor)));
	} catch {
		throw new ApiError('validation', 'Invalid cursor');
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw new ApiError('validation', 'Invalid cursor');
	return parsed.data;
}

export function resolveLimit(requested: number | undefined): number {
	if (requested === undefined) return DEFAULT_LIMIT;
	if (!Number.isInteger(requested) || requested < 1) {
		throw new ApiError('validation', 'limit must be a positive integer');
	}
	return Math.min(requested, MAX_LIMIT);
}

// callers fetch limit + 1 rows; the extra row is the only signal that a next page exists
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => unknown): Page<T> {
	const items = rows.slice(0, limit);
	const last = items.at(-1);
	if (rows.length <= limit || last === undefined) return { items, nextCursor: null };
	return { items, nextCursor: encodeCursor(cursorOf(last)) };
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
	if (!BASE64URL.test(text)) throw new ApiError('validation', 'Invalid cursor');
	const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
	return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}
