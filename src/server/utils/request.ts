import type { z } from 'zod';
import { ApiError } from '../../shared/errors';

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
	if (new TextEncoder().encode(text).byteLength > maxBytes) {
		throw new ApiError('validation', 'Request body is too large');
	}
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
