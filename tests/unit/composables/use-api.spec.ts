import { afterEach, describe, expect, it } from 'vitest';
import { ApiClientError, useApi } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

let cleanup: () => void = () => undefined;

afterEach(() => {
	cleanup();
	clearBrowserState();
	useSessionStore().$reset();
});

describe('useApi', () => {
	it('treats a 204 with no body as a successful result', async () => {
		cleanup = registerApi({ 'POST /api/v1/auth/logout': { status: 204, body: undefined } });
		const session = useSessionStore();
		session.me = {
			id: 'usr_1',
			email: 'a@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null
		};

		await expect(useApi().post('/auth/logout')).resolves.toBeFalsy();

		expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
			'POST /api/v1/auth/logout'
		]);
		expect(session.me).not.toBeNull();
	});

	it('clears the session and throws a typed error on a 401', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': {
				status: 401,
				body: {
					code: 'unauthenticated',
					message: 'Sign in',
					details: {},
					requestId: 'req_1'
				}
			}
		});
		const session = useSessionStore();
		session.me = {
			id: 'usr_1',
			email: 'a@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null
		};

		const failure = await useApi()
			.get('/me')
			.catch((error: unknown) => error);

		expect(failure).toBeInstanceOf(ApiClientError);
		expect((failure as ApiClientError).requestId).toBe('req_1');
		expect(session.me).toBeNull();
	});
});
