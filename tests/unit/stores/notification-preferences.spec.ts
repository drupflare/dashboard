import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PreferencesView } from '~/shared/notification-preferences';
import { useNotificationPreferencesStore } from '~/stores/notification-preferences';
import { calls, clearBrowserState, registerApi } from './store-support';

const path = '/api/v1/me/notifications';

const view = (ops: boolean): PreferencesView => ({
	switches: [
		{
			category: 'ops',
			label: 'Operations Updates',
			description: 'x',
			available: true,
			enabled: ops
		},
		{
			category: 'digest',
			label: 'Daily Summary',
			description: 'y',
			available: false,
			enabled: false
		}
	],
	essential: [{ label: 'Failed Payments', description: 'z' }]
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useNotificationPreferencesStore().$reset();
});

afterEach(() => cleanup());

const count = (method: string, route: string) =>
	calls.filter((call) => call.method === method && call.path === route).length;

describe('notification preferences store', () => {
	it('is undefined before it loads, loads once, and reads again only when forced', async () => {
		cleanup = registerApi({ [`GET ${path}`]: { body: view(false) } });
		const store = useNotificationPreferencesStore();
		expect(store.current).toBeUndefined();
		await store.load();
		await store.load();
		expect(count('GET', path)).toBe(1);
		expect(store.current).toEqual(view(false));
		await store.load(true);
		expect(count('GET', path)).toBe(2);
	});

	it('keeps the error and leaves the value unloaded when the read fails', async () => {
		cleanup = registerApi({
			[`GET ${path}`]: {
				status: 500,
				body: { code: 'internal', message: 'Broken', details: {}, requestId: 'req_1' }
			}
		});
		const store = useNotificationPreferencesStore();
		await store.load();
		expect(store.error?.message).toBe('Broken');
		expect(store.current).toBeUndefined();
	});

	it('sends one category and keeps the view the server returns', async () => {
		cleanup = registerApi({ [`PUT ${path}`]: { body: view(true) } });
		const store = useNotificationPreferencesStore();
		expect(await store.set('ops', true)).toBe(true);
		expect(calls.find((call) => call.path === path)?.body).toEqual({
			preferences: { ops: true }
		});
		expect(store.current?.switches[0]?.enabled).toBe(true);
	});

	it('keeps the old view and the error when a change is refused', async () => {
		cleanup = registerApi({
			[`GET ${path}`]: { body: view(false) },
			[`PUT ${path}`]: {
				status: 400,
				body: { code: 'validation', message: 'Refused', details: {}, requestId: 'req_2' }
			}
		});
		const store = useNotificationPreferencesStore();
		await store.load();
		expect(await store.set('ops', true)).toBe(false);
		expect(store.saveError?.message).toBe('Refused');
		expect(store.current?.switches[0]?.enabled).toBe(false);
	});

	it('posts the token from the mail link on the query of the public route', async () => {
		const route = '/api/v1/unsubscribe';
		cleanup = registerApi({
			[`POST ${route}`]: { body: { unsubscribed: true, category: 'ops' } }
		});
		const token = 'a.b'.repeat(15);
		const result = await useNotificationPreferencesStore().unsubscribe(token);
		expect(result).toEqual({ unsubscribed: true, category: 'ops' });
		expect(calls.find((call) => call.path === route)?.query).toEqual({ token });
	});

	it('returns null when the link is refused', async () => {
		cleanup = registerApi({
			'POST /api/v1/unsubscribe': {
				status: 400,
				body: { code: 'validation', message: 'Old link', details: {}, requestId: 'req_3' }
			}
		});
		const store = useNotificationPreferencesStore();
		expect(await store.unsubscribe('x'.repeat(30))).toBeNull();
		expect(store.saveError?.message).toBe('Old link');
	});
});
