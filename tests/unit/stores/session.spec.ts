import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, cookieValue, failure, registerApi } from './store-support';

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

	it('reads the hint cookie on creation and makes no request for it', () => {
		const session = useSessionStore();
		expect(session.hinted).toBe(false);
		expect(session.signedIn).toBe(false);

		document.cookie = 'drupflare_in=1; path=/';
		session.$reset();

		expect(session.hinted).toBe(true);
		expect(session.me).toBeUndefined();
		expect(session.signedIn).toBe(true);
		expect(calls).toHaveLength(0);
	});

	it('ignores a hint cookie with any other value', () => {
		document.cookie = 'drupflare_in=0; path=/';
		const session = useSessionStore();
		session.$reset();
		expect(session.hinted).toBe(false);
	});

	it('lets the loaded account override the hint', async () => {
		document.cookie = 'drupflare_in=1; path=/';
		const session = useSessionStore();
		session.$reset();
		session.me = null;
		expect(session.signedIn).toBe(false);

		cleanup = registerApi({ 'GET /api/v1/me': { body: me } });
		session.$reset();
		await session.load();
		expect(session.signedIn).toBe(true);
	});

	it('settles a wrong hint on the 401: hint and cookie cleared, no error', async () => {
		cleanup = registerApi({ 'GET /api/v1/me': unauthenticated });
		document.cookie = 'drupflare_in=1; path=/';
		const session = useSessionStore();
		session.$reset();
		expect(session.signedIn).toBe(true);

		await session.load();

		expect(session.hinted).toBe(false);
		expect(session.signedIn).toBe(false);
		expect(session.error).toBeNull();
		expect(cookieValue('drupflare_in')).toBeFalsy();
	});

	it('keeps the hint when the server fails to answer', async () => {
		cleanup = registerApi({ 'GET /api/v1/me': failure('internal', 'failed', 'req_500') });
		document.cookie = 'drupflare_in=1; path=/';
		const session = useSessionStore();
		session.$reset();

		await session.load();

		expect(session.hinted).toBe(true);
		expect(session.signedIn).toBe(true);
	});

	it('raises the hint when the account loads and drops it on sign-out', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'POST /api/v1/auth/logout': { status: 204, body: undefined }
		});
		const session = useSessionStore();
		await session.load();
		expect(session.hinted).toBe(true);

		await session.signOut();
		expect(session.hinted).toBe(false);
		expect(session.signedIn).toBe(false);
	});

	it('drops a /me answer that was in flight when the session ended', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		cleanup = registerApi({
			'GET /api/v1/me': async () => {
				await gate;
				return { body: me };
			},
			'POST /api/v1/auth/logout': { status: 204, body: undefined }
		});
		const session = useSessionStore();
		const loading = session.load();
		await vi.waitFor(() => expect(calls).toHaveLength(1));

		await session.signOut();
		release();
		await loading;

		expect(session.me).toBeNull();
		expect(session.hinted).toBe(false);
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
