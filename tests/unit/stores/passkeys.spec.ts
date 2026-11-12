import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePasskeysStore } from '~/stores/passkeys';
import { calls, clearBrowserState, registerApi } from './store-support';

const startRegistration = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/browser', () => ({ startRegistration }));

const passkey = (id: string, name: string, createdAt: string) => ({
	id,
	name,
	deviceType: 'multiDevice' as const,
	backedUp: true,
	createdAt,
	lastUsedAt: null
});

const envelope = (status: number, code: string, message: string) => ({
	status,
	body: { code, message, details: {}, requestId: 'req_1' }
});

const options = {
	challenge: 'abc',
	rp: { name: 'Drupflare' },
	user: { id: 'u', name: 'a', displayName: 'a' }
};
const response = { id: 'cred_1', rawId: 'cred_1', type: 'public-key', response: {} };

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	startRegistration.mockReset();
	usePasskeysStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('passkeys store', () => {
	it('stays not loaded until the list is read', () => {
		expect(usePasskeysStore().items).toBeUndefined();
	});

	it('loads the list the server sends', async () => {
		const items = [passkey('pk_2', 'Laptop', '2026-11-02T00:00:00.000Z')];
		cleanup = registerApi({ 'GET /api/v1/me/passkeys': { body: { items, nextCursor: null } } });
		const store = usePasskeysStore();
		await store.load();
		expect(store.items).toEqual(items);
		expect(store.error).toBeNull();
	});

	it('keeps an empty list as a loaded list', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/passkeys': { body: { items: [], nextCursor: null } }
		});
		const store = usePasskeysStore();
		await store.load();
		expect(store.items).toEqual([]);
	});

	it('keeps the list not loaded and records the error when the read fails', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/passkeys': envelope(500, 'internal', 'Passkeys are down')
		});
		const store = usePasskeysStore();
		await store.load();
		expect(store.items).toBeUndefined();
		expect(store.error?.message).toBe('Passkeys are down');
	});

	it('registers a passkey in two calls and reloads the list', async () => {
		startRegistration.mockResolvedValue(response);
		cleanup = registerApi({
			'POST /api/v1/me/passkeys/register': (call) =>
				call.body && (call.body as { phase: string }).phase === 'options'
					? { body: { options } }
					: {
							body: {
								passkey: passkey('pk_3', 'Desk Key', '2026-11-03T00:00:00.000Z')
							}
						},
			'GET /api/v1/me/passkeys': { body: { items: [], nextCursor: null } }
		});
		await usePasskeysStore().register('Desk Key');
		expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: options });
		expect(calls.slice(0, 2).map((call) => call.body)).toEqual([
			{ phase: 'options' },
			{ phase: 'verify', response, name: 'Desk Key' }
		]);
		expect(calls.at(-1)?.method).toBe('GET');
	});

	it('sends no verify call when the browser cancels the prompt', async () => {
		startRegistration.mockRejectedValue(
			Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
		);
		cleanup = registerApi({ 'POST /api/v1/me/passkeys/register': { body: { options } } });
		const store = usePasskeysStore();
		await expect(store.register('')).rejects.toMatchObject({ name: 'NotAllowedError' });
		expect(calls).toHaveLength(1);
	});

	it('surfaces the server message when the new passkey cannot be verified', async () => {
		startRegistration.mockResolvedValue(response);
		cleanup = registerApi({
			'POST /api/v1/me/passkeys/register': (call) =>
				(call.body as { phase: string }).phase === 'options'
					? { body: { options } }
					: envelope(400, 'validation', 'The passkey could not be verified')
		});
		await expect(usePasskeysStore().register('')).rejects.toMatchObject({
			message: 'The passkey could not be verified'
		});
	});

	it('renames a passkey on the server and in the list', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/passkeys': {
				body: {
					items: [passkey('pk_1', 'Old', '2026-11-01T00:00:00.000Z')],
					nextCursor: null
				}
			},
			'PATCH /api/v1/me/passkeys/pk_1': { status: 204, body: null }
		});
		const store = usePasskeysStore();
		await store.load();
		await store.rename('pk_1', 'Work Laptop');
		expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: '/api/v1/me/passkeys/pk_1' });
		expect(calls.at(-1)?.body).toEqual({ name: 'Work Laptop' });
		expect(store.items?.[0]?.name).toBe('Work Laptop');
	});

	it('removes a passkey from the list', async () => {
		cleanup = registerApi({
			'GET /api/v1/me/passkeys': {
				body: {
					items: [
						passkey('pk_1', 'One', '2026-11-01T00:00:00.000Z'),
						passkey('pk_2', 'Two', '2026-11-02T00:00:00.000Z')
					],
					nextCursor: null
				}
			},
			'DELETE /api/v1/me/passkeys/pk_2': { status: 204, body: null }
		});
		const store = usePasskeysStore();
		await store.load();
		await store.remove('pk_2');
		expect(store.items?.map((item) => item.id)).toEqual(['pk_1']);
	});

	it('keeps the passkey and throws the server refusal when it is the last sign-in method', async () => {
		cleanup = registerApi({
			'DELETE /api/v1/me/passkeys/pk_1': envelope(
				409,
				'conflict',
				'This is your last sign-in method, so it cannot be removed'
			)
		});
		const store = usePasskeysStore();
		store.items = [passkey('pk_1', 'Only', '2026-11-01T00:00:00.000Z')];
		await expect(store.remove('pk_1')).rejects.toMatchObject({
			message: 'This is your last sign-in method, so it cannot be removed',
			status: 409
		});
		expect(store.items).toHaveLength(1);
	});
});
