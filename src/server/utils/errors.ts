import { ApiError, type ErrorBody } from '../../shared/errors';

export function toApiError(value: unknown): ApiError {
	if (value instanceof ApiError) return value;
	return new ApiError('internal', 'Internal error');
}

export function toErrorBody(value: unknown, requestId: string): ErrorBody {
	const error = toApiError(value);
	return { code: error.code, message: error.message, details: error.details, requestId };
}
