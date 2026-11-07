import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime';
import { defineEventHandler, setResponseStatus } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authMiddleware from '~/middleware/auth';
import orgMiddleware from '~/middleware/org';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const cleanups: (() => void)[] = [];

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const unauthenticated: Reply = {
	status: 401,
	body: { code: 'unauthenticated', message: 'Sign in', details: {}, requestId: 'req_mw' }
};

function hint() {
	document.cookie = 'drupflare_in=1; path=/';
	useSessionStore().$reset();
}

beforeEach(() => {
	navigate.mockClear();
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
});

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('auth route middleware', () => {
	it('sends a signed-out visitor to sign in and keeps the page they asked for', async () => {
		cleanups.push(
			registerEndpoint('/api/v1/me', {
				handler: defineEventHandler((event) => {
					setResponseStatus(event, 401);
					return {
						code: 'unauthenticated',
						message: 'Authentication is required',
						details: {},
						requestId: 'req_mw'
					};
				})
			})
		);

		await authMiddleware({ fullPath: '/sites?page=2' } as never, {} as never);

		expect(navigate).toHaveBeenCalledWith({
			path: '/login',
			query: { redirect: '/sites?page=2' }
		});
	});

	it('lets a signed-in visitor through', async () => {
		cleanups.push(
			registerEndpoint('/api/v1/me', {
				handler: defineEventHandler(() => ({
					id: 'usr_1',
					email: 'owner@example.test',
					displayName: null,
					via: 'session',
					stepUpUntil: null
				}))
			})
		);

		await authMiddleware({ fullPath: '/sites' } as never, {} as never);

		expect(navigate).not.toHaveBeenCalled();
	});

	it('starts /me and /me/organizations together for a hinted visitor', async () => {
		const events: string[] = [];
		let hits = 0;
		let release: () => void = () => undefined;
		const both = new Promise<void>((resolve) => {
			release = resolve;
		});
		const answer = (name: string, reply: Reply) => async () => {
			events.push(`${name}:start`);
			if (++hits === 2) release();
			await Promise.race([both, new Promise((resolve) => setTimeout(resolve, 1500))]);
			events.push(`${name}:end`);
			return reply;
		};
		cleanups.push(
			registerApi({
				'GET /api/v1/me': answer('me', { body: me }),
				'GET /api/v1/me/organizations': answer('orgs', {
					body: { items: [personal], nextCursor: null }
				})
			})
		);
		hint();

		await authMiddleware({ fullPath: '/sites' } as never, {} as never);

		expect(events.slice(0, 2).sort()).toEqual(['me:start', 'orgs:start']);
		expect(useSessionStore().me).toEqual(me);
		expect(useOrgStore().current?.id).toBe('org_personal');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('leaves the organizations for the page when the visitor has no hint', async () => {
		cleanups.push(
			registerApi({
				'GET /api/v1/me': { body: me },
				'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } }
			})
		);

		await authMiddleware({ fullPath: '/account' } as never, {} as never);

		expect(calls.map((call) => call.path)).toEqual(['/api/v1/me']);
	});

	it('signs a hinted visitor out and redirects when the organizations answer 401', async () => {
		cleanups.push(
			registerApi({
				'GET /api/v1/me': { body: me },
				'GET /api/v1/me/organizations': unauthenticated
			})
		);
		hint();

		await authMiddleware({ fullPath: '/new' } as never, {} as never);

		expect(useSessionStore().me).toBeNull();
		expect(useSessionStore().hinted).toBe(false);
		expect(navigate).toHaveBeenCalledWith({ path: '/login', query: { redirect: '/new' } });
	});

	it('redirects a wrong hint once /me answers 401', async () => {
		cleanups.push(
			registerApi({
				'GET /api/v1/me': unauthenticated,
				'GET /api/v1/me/organizations': unauthenticated
			})
		);
		hint();

		await authMiddleware({ fullPath: '/sites' } as never, {} as never);

		expect(navigate).toHaveBeenCalledTimes(1);
		expect(useOrgStore().error).toBeNull();
	});
});

describe('org route middleware', () => {
	const sitesKey = `GET /api/v1/orgs/${personal.id}/sites`;

	async function signedIn() {
		cleanups.push(
			registerApi({
				'GET /api/v1/me': { body: me },
				'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
				[sitesKey]: { body: { items: [], nextCursor: null } }
			})
		);
		await useSessionStore().ensure();
	}

	it('starts the sites list as soon as the organization is known on the sites page', async () => {
		await signedIn();

		await orgMiddleware({ path: '/sites' } as never, {} as never);

		await vi.waitFor(() =>
			expect(useSitesStore().lists.get(personal.id)?.status).toBe('ready')
		);
		expect(calls.filter((call) => call.path.endsWith('/sites'))).toHaveLength(1);
	});

	it('does not read the sites list for other pages', async () => {
		await signedIn();

		await orgMiddleware({ path: '/new' } as never, {} as never);

		expect(useOrgStore().current?.id).toBe('org_personal');
		expect(calls.some((call) => call.path.endsWith('/sites'))).toBe(false);
	});

	it('does nothing for a visitor who is not signed in', async () => {
		cleanups.push(registerApi({ 'GET /api/v1/me': unauthenticated }));
		await useSessionStore().ensure();

		await orgMiddleware({ path: '/sites' } as never, {} as never);

		expect(calls.map((call) => call.path)).toEqual(['/api/v1/me']);
	});
});
