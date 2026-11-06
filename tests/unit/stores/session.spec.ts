import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const unauthenticated = {
	status: 401,
	body: {
		code: 'unauthenticated',
		message: 'Authentication is required',
		details: {},
		requestId: 'req_401'
	}
};

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('session store', () => {
	it('loads the signed-in account once', async () => {
		cleanup = registerApi({ 'GET /api/v1/me': { body: me } });
		const session = useSessionStore();
		expect(session.me).toBeUndefined();

		await session.ensure();
		await session.ensure();

		expect(session.me).toEqual(me);
		expect(calls.filter((call) => call.path === '/api/v1/me')).toHaveLength(1);
	});

	it('records a 401 as signed out and clears the organization and site caches', async () => {
		cleanup = registerApi({ 'GET /api/v1/me': unauthenticated });
		const org = useOrgStore();
		org.items = [{ id: 'org_a', name: 'A', personal: true, role: 'owner' }];
		const sites = useSitesStore();
		sites.lists.set('org_a', { ids: [], nextCursor: null, status: 'ready', error: null });

		const session = useSessionStore();
		await session.load();

		expect(session.me).toBeNull();
		expect(session.error).toBeNull();
		expect(org.items).toBeUndefined();
		expect(sites.lists.size).toBe(0);
	});

	it('keeps the account unknown and stores the error when the server fails', async () => {
		cleanup = registerApi({ 'GET /api/v1/me': failure('internal', 'failed', 'req_500') });
		const session = useSessionStore();
		await session.load();

		expect(session.me).toBeUndefined();
		expect(session.error?.code).toBe('internal');
		expect(session.error?.requestId).toBe('req_500');
	});

	it('posts sign-out and clears the account', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'POST /api/v1/auth/logout': { status: 204, body: undefined }
		});
		const session = useSessionStore();
		await session.load();

		await session.signOut();
		expect(
			calls.some((call) => call.method === 'POST' && call.path === '/api/v1/auth/logout')
		).toBe(true);
		expect(session.me).toBeNull();
	});

	it('keeps the account when sign-out fails on the server', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'POST /api/v1/auth/logout': failure('internal', 'failed', 'req_out')
		});
		const session = useSessionStore();
		await session.load();

		await session.signOut();

		expect(session.me).toEqual(me);
		expect(session.error?.code).toBe('internal');
	});
});
