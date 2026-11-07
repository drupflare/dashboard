import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminGet } from '~/composables/useAdminApi';
import { ApiClientError } from '~/composables/useApi';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, registerApi } from '../stores/store-support';

const unreachable = vi.hoisted(() => ({ on: false }));

// a redirect fetch cannot follow reaches the page as a failure with no response, which the
// local test server cannot produce
vi.mock('~/composables/useApi', async (importOriginal) => {
	const actual = await importOriginal<typeof import('~/composables/useApi')>();
	return {
		...actual,
		useApi: () => ({
			...actual.useApi(),
			get: (path: string, query?: Record<string, string>) =>
				unreachable.on
					? Promise.reject(new actual.ApiClientError('network', 'offline', 0, null, null))
					: actual.useApi().get(path, query)
		})
	};
});

const overview = { users: 1, organizations: 1, sites: {}, operations: {} };
const forbidden = {
	status: 403,
	body: { code: 'forbidden', message: 'No access', details: {}, requestId: 'req_403' }
};

let cleanup: () => void = () => undefined;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	unreachable.on = false;
	assign = vi.fn();
	vi.spyOn(window.location, 'assign').mockImplementation(assign as never);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

const settled = (promise: Promise<unknown>) =>
	Promise.race([
		promise.then(
			() => 'resolved',
			() => 'rejected'
		),
		new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 50))
	]);

describe('adminGet', () => {
	it('returns the data and leaves the page alone', async () => {
		cleanup = registerApi({ 'GET /api/v1/admin/overview': { body: overview } });
		await expect(adminGet('/admin/overview')).resolves.toEqual(overview);
		expect(assign).not.toHaveBeenCalled();
	});

	it('loads /admin as a full page once when the call fails with no response', async () => {
		unreachable.on = true;

		expect(await settled(adminGet('/admin/overview'))).toBe('pending');

		expect(assign).toHaveBeenCalledTimes(1);
		expect(assign).toHaveBeenCalledWith('/admin');
	});

	it('loads /admin as a full page once when the server answers 403', async () => {
		cleanup = registerApi({ 'GET /api/v1/admin/overview': forbidden });

		expect(await settled(adminGet('/admin/overview'))).toBe('pending');

		expect(assign).toHaveBeenCalledWith('/admin');
	});

	it('shows the error instead of looping when the call still fails after the reload', async () => {
		cleanup = registerApi({ 'GET /api/v1/admin/overview': forbidden });
		expect(await settled(adminGet('/admin/overview'))).toBe('pending');

		const second = adminGet('/admin/overview');

		await expect(second).rejects.toBeInstanceOf(ApiClientError);
		await expect(second).rejects.toMatchObject({ code: 'forbidden', requestId: 'req_403' });
		expect(assign).toHaveBeenCalledTimes(1);
	});

	it('shows the error instead of looping for a repeated no-response failure', async () => {
		unreachable.on = true;
		expect(await settled(adminGet('/admin/overview'))).toBe('pending');

		await expect(adminGet('/admin/overview')).rejects.toMatchObject({ code: 'network' });
		expect(assign).toHaveBeenCalledTimes(1);
	});

	it('allows another reload after a call has succeeded', async () => {
		cleanup = registerApi({ 'GET /api/v1/admin/overview': forbidden });
		expect(await settled(adminGet('/admin/overview'))).toBe('pending');
		cleanup();

		cleanup = registerApi({ 'GET /api/v1/admin/overview': { body: overview } });
		await adminGet('/admin/overview');
		cleanup();

		cleanup = registerApi({ 'GET /api/v1/admin/overview': forbidden });
		expect(await settled(adminGet('/admin/overview'))).toBe('pending');
		expect(assign).toHaveBeenCalledTimes(2);
	});

	it('does not reload for a server failure', async () => {
		cleanup = registerApi({
			'GET /api/v1/admin/overview': {
				status: 500,
				body: { code: 'internal', message: 'failed', details: {}, requestId: 'req_500' }
			}
		});
		await expect(adminGet('/admin/overview')).rejects.toMatchObject({ code: 'internal' });
		expect(assign).not.toHaveBeenCalled();
	});

	it('does not reload for a 401, which signs the visitor out instead', async () => {
		cleanup = registerApi({
			'GET /api/v1/admin/overview': {
				status: 401,
				body: { code: 'unauthenticated', message: 'Sign in', details: {}, requestId: 'r' }
			}
		});
		await expect(adminGet('/admin/overview')).rejects.toMatchObject({
			code: 'unauthenticated'
		});
		expect(assign).not.toHaveBeenCalled();
		expect(useSessionStore().me).toBeNull();
	});

	it('never reloads when the browser blocks storage, so it cannot loop', async () => {
		cleanup = registerApi({ 'GET /api/v1/admin/overview': forbidden });
		const blocked = () => {
			throw new Error('blocked');
		};
		vi.stubGlobal('sessionStorage', {
			getItem: blocked,
			setItem: blocked,
			removeItem: blocked
		});

		await expect(adminGet('/admin/overview')).rejects.toMatchObject({ code: 'forbidden' });
		expect(assign).not.toHaveBeenCalled();
	});
});
