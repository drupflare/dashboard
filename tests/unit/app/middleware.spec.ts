import { mockNuxtImport, registerEndpoint } from '@nuxt/test-utils/runtime';
import { defineEventHandler, setResponseStatus } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import authMiddleware from '~/middleware/auth';
import { useSessionStore } from '~/stores/session';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const cleanups: (() => void)[] = [];

beforeEach(() => {
	navigate.mockClear();
	useSessionStore().$reset();
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
});
