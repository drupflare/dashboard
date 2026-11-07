import type { ErrorCode } from '~/shared/errors';
import { useSessionStore } from '~/stores/session';

export type ApiClientErrorCode = ErrorCode | 'network' | 'unknown';

export class ApiClientError extends Error {
	readonly code: ApiClientErrorCode;
	readonly status: number;
	readonly details: unknown;
	readonly requestId: string | null;

	constructor(
		code: ApiClientErrorCode,
		message: string,
		status: number,
		details: unknown,
		requestId: string | null
	) {
		super(message);
		this.name = 'ApiClientError';
		this.code = code;
		this.status = status;
		this.details = details;
		this.requestId = requestId;
	}
}

const KNOWN_CODES: ReadonlySet<string> = new Set<ErrorCode>([
	'validation',
	'unauthenticated',
	'forbidden',
	'not_found',
	'conflict',
	'precondition_failed',
	'unprocessable',
	'contract_unsupported',
	'rate_limited',
	'not_built',
	'internal'
]);

const CODE_BY_STATUS: Record<number, ApiClientErrorCode> = {
	400: 'validation',
	401: 'unauthenticated',
	403: 'forbidden',
	404: 'not_found',
	409: 'conflict',
	412: 'precondition_failed',
	422: 'unprocessable',
	426: 'contract_unsupported',
	429: 'rate_limited',
	501: 'not_built'
};

const FALLBACK_MESSAGE: Record<ApiClientErrorCode, string> = {
	validation: 'Check the values you entered and try again.',
	unauthenticated: 'Your session has ended. Sign in again.',
	forbidden: 'You do not have permission to do that.',
	not_found: 'That item could not be found.',
	conflict: 'That change conflicts with the current state. Refresh and try again.',
	precondition_failed: 'The item changed since you loaded it. Refresh and try again.',
	unprocessable: 'The request could not be processed.',
	contract_unsupported: 'This dashboard is out of date. Reload the page.',
	rate_limited: 'Too many requests. Wait a moment and try again.',
	not_built: 'This feature is not available yet.',
	internal: 'Something went wrong on our side. Try again.',
	network: 'We could not reach the server. Check your connection and try again.',
	unknown: 'The request failed. Try again.'
};

type Envelope = { code: string; message: string; details?: unknown; requestId?: string };

type FailureLike = {
	statusCode?: number;
	status?: number;
	data?: unknown;
	response?: {
		status?: number;
		_data?: unknown;
		headers?: { get?: (name: string) => string | null };
	};
};

function isEnvelope(value: unknown): value is Envelope {
	const candidate = value as Partial<Envelope> | null;
	return typeof candidate?.code === 'string' && typeof candidate.message === 'string';
}

function codeForStatus(status: number | undefined): ApiClientErrorCode {
	if (status === undefined) return 'unknown';
	if (CODE_BY_STATUS[status]) return CODE_BY_STATUS[status];
	return status >= 500 ? 'internal' : 'unknown';
}

export function toApiClientError(error: unknown): ApiClientError {
	if (error instanceof ApiClientError) return error;

	const failure = (typeof error === 'object' && error !== null ? error : {}) as FailureLike;
	const status = failure.statusCode ?? failure.status ?? failure.response?.status;
	const body = failure.data ?? failure.response?._data;
	const headerId = failure.response?.headers?.get?.('x-request-id') ?? null;

	if (status === undefined && body === undefined) {
		return new ApiClientError('network', FALLBACK_MESSAGE.network, 0, null, null);
	}

	if (isEnvelope(body)) {
		const code: ApiClientErrorCode = KNOWN_CODES.has(body.code)
			? (body.code as ErrorCode)
			: 'unknown';
		return new ApiClientError(
			code,
			body.message,
			status ?? 0,
			body.details ?? null,
			body.requestId ?? headerId
		);
	}

	const code = codeForStatus(status);
	return new ApiClientError(code, FALLBACK_MESSAGE[code], status ?? 0, null, headerId);
}

type Fetcher = (
	url: string,
	options: {
		method: 'GET' | 'POST' | 'DELETE';
		query?: Record<string, string>;
		body?: Record<string, unknown>;
	}
) => Promise<unknown>;

export function useApi() {
	// the typed route map only covers literal paths; this client builds them at runtime
	const fetcher = $fetch as unknown as Fetcher;

	async function settle<T>(request: Promise<unknown>): Promise<T> {
		try {
			return (await request) as T;
		} catch (error) {
			const apiError = toApiClientError(error);
			if (apiError.status === 401) useSessionStore().clear();
			throw apiError;
		}
	}

	return {
		get: <T>(path: string, query?: Record<string, string>) =>
			settle<T>(fetcher(`/api/v1${path}`, { method: 'GET', query })),
		post: <T>(path: string, body?: Record<string, unknown>) =>
			settle<T>(fetcher(`/api/v1${path}`, { method: 'POST', body })),
		delete: <T>(path: string) => settle<T>(fetcher(`/api/v1${path}`, { method: 'DELETE' }))
	};
}
