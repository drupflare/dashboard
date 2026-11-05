import { describe, expect, it } from 'vitest';
import { toApiError, toErrorBody } from '../../../../src/server/utils/errors';
import { ApiError, ERROR_STATUS } from '../../../../src/shared/errors';

describe('error catalogue', () => {
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
	] as const)('%s maps to %i', (code, status) => {
		const error = new ApiError(code, 'message');
		expect(error.code).toBe(code);
		expect(error.status).toBe(status);
		expect(ERROR_STATUS[code]).toBe(status);
	});

	it('has no codes beyond the eleven listed', () => {
		expect(Object.keys(ERROR_STATUS)).toHaveLength(11);
	});
});

describe('toErrorBody', () => {
	it('returns the wire shape with the request id', () => {
		const error = new ApiError('validation', 'Bad', [{ path: 'limit', message: 'Too big' }]);
		expect(toErrorBody(error, 'req_1')).toEqual({
			code: 'validation',
			message: 'Bad',
			details: [{ path: 'limit', message: 'Too big' }],
			requestId: 'req_1'
		});
	});

	it('sends null details when none were given', () => {
		expect(toErrorBody(new ApiError('not_found', 'Missing'), 'req_2').details).toBeNull();
	});

	it('turns an unknown thrown error into internal without its message', () => {
		expect(toErrorBody(new Error('password=hunter2 at db.sql:3'), 'req_3')).toEqual({
			code: 'internal',
			message: 'Internal error',
			details: null,
			requestId: 'req_3'
		});
	});

	it('does the same for a thrown string', () => {
		expect(toErrorBody('secret token', 'req_4')).toMatchObject({
			code: 'internal',
			message: 'Internal error'
		});
	});
});

describe('toApiError', () => {
	it('returns an ApiError unchanged', () => {
		const error = new ApiError('conflict', 'Taken');
		expect(toApiError(error)).toBe(error);
	});

	it('maps an unknown value to a 500', () => {
		const error = toApiError(42);
		expect(error.code).toBe('internal');
		expect(error.status).toBe(500);
	});
});
