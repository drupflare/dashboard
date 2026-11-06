import { describe, expect, it } from 'vitest';
import { ApiClientError, toApiClientError } from '~/composables/useApi';

const body = (code: string, extra: Record<string, unknown> = {}) => ({
	code,
	message: `message for ${code}`,
	details: {},
	requestId: 'req_body',
	...extra
});

describe('toApiClientError', () => {
	it.each([
		['validation', 400],
		['unauthenticated', 401],
		['forbidden', 403],
		['not_found', 404],
		['conflict', 409],
		['precondition_failed', 412],
		['unprocessable', 422],
		['contract_unsupported', 426],
		['rate_limited', 429],
		['not_built', 501],
		['internal', 500]
	])('maps the %s error body with status %i', (code, status) => {
		const error = toApiClientError({ statusCode: status, data: body(code) });
		expect(error).toBeInstanceOf(ApiClientError);
		expect(error.code).toBe(code);
		expect(error.status).toBe(status);
		expect(error.message).toBe(`message for ${code}`);
		expect(error.requestId).toBe('req_body');
	});

	it('keeps the details the server sent', () => {
		const error = toApiClientError({
			statusCode: 429,
			data: body('rate_limited', { details: { retryAfterSeconds: 90 } })
		});
		expect(error.details).toEqual({ retryAfterSeconds: 90 });
	});

	it('reads the status and body from the response when the error has neither', () => {
		const error = toApiClientError({ response: { status: 404, _data: body('not_found') } });
		expect(error.code).toBe('not_found');
		expect(error.status).toBe(404);
	});

	it('reports a failed request as a network error', () => {
		const error = toApiClientError(new TypeError('fetch failed'));
		expect(error.code).toBe('network');
		expect(error.status).toBe(0);
		expect(error.requestId).toBeNull();
	});

	it('uses the request id header when the body has none', () => {
		const error = toApiClientError({
			statusCode: 500,
			data: { code: 'internal', message: 'failed', details: null },
			response: { headers: new Headers({ 'x-request-id': 'req_header' }) }
		});
		expect(error.requestId).toBe('req_header');
	});

	it('marks a body with a code this client does not know as unknown', () => {
		const error = toApiClientError({ statusCode: 418, data: body('teapot') });
		expect(error.code).toBe('unknown');
		expect(error.status).toBe(418);
	});

	it('falls back to the status when a failure has no error body', () => {
		const error = toApiClientError({ statusCode: 502, data: '<html>bad gateway</html>' });
		expect(error.code).toBe('internal');
		expect(error.status).toBe(502);
	});

	it('returns an ApiClientError unchanged', () => {
		const original = new ApiClientError('forbidden', 'no', 403, null, null);
		expect(toApiClientError(original)).toBe(original);
	});
});
