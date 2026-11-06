import { getRequestHeader, getRequestWebStream, type H3Event } from 'h3';
import type { z } from 'zod';
import { ApiError } from '../../shared/errors';

const tooLarge = () => new ApiError('validation', 'Request body is too large');

// counts bytes as they arrive and stops reading at the first byte past the cap, so a body that is
// larger than declared, or has no declared length, never sits in memory whole
export async function readCappedBody(event: H3Event, maxBytes: number): Promise<string> {
	if (Number(getRequestHeader(event, 'content-length') ?? 0) > maxBytes) throw tooLarge();
	const stream = getRequestWebStream(event);
	if (!stream) return '';
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw tooLarge();
		}
		chunks.push(value);
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

export function parseQuery<T extends z.ZodType>(
	schema: T,
	searchParams: URLSearchParams
): z.infer<T> {
	const parsed = schema.safeParse(Object.fromEntries(searchParams));
	if (!parsed.success) throw validationError(parsed.error);
	return parsed.data;
}

export function parseBody<T extends z.ZodType>(
	schema: T,
	text: string,
	maxBytes: number
): z.infer<T> {
	if (new TextEncoder().encode(text).byteLength > maxBytes) throw tooLarge();
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new ApiError('validation', 'Request body is not valid JSON');
	}
	const parsed = schema.safeParse(json);
	if (!parsed.success) throw validationError(parsed.error);
	return parsed.data;
}

function validationError(error: z.ZodError): ApiError {
	const details = error.issues.map((issue) => ({
		path: issue.path.map(String).join('.'),
		message: issue.message
	}));
	return new ApiError('validation', 'Request is invalid', details);
}
