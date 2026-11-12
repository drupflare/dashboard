import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDevicesStore, type Device } from '~/stores/devices';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const device = (id: string, current = false): Device => ({
	id,
	device: 'Chrome on macOS',
	ip: '203.0.113.0/24',
	createdAt: '2026-11-01T12:00:00.000Z',
	lastSeenAt: '2026-11-10T12:00:00.000Z',
	current
});

const listPath = '/api/v1/me/sessions';

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useDevicesStore().$reset();
});

afterEach(() => {
	cleanup();
});

describe('devices store', () => {
	it('stays undefined until the list loads, then holds it', async () => {
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [device('ses_a', true)] } }
		});
		const devices = useDevicesStore();
		expect(devices.items).toBeUndefined();

		await devices.load();

		expect(devices.items?.map((item) => item.id)).toEqual(['ses_a']);
		expect(devices.error).toBeNull();
	});

	it('keeps the error when the list fails, and clears it on the next good load', async () => {
		let fail = true;
		cleanup = registerApi({
			[`GET ${listPath}`]: () =>
				fail
					? failure('internal', 'The devices could not be listed', 'req_dev1')
					: { body: { items: [device('ses_a', true)] } }
		});
		const devices = useDevicesStore();

		await devices.load();
		expect(devices.items).toBeUndefined();
		expect(devices.error?.message).toBe('The devices could not be listed');

		fail = false;
		await devices.load();
		expect(devices.error).toBeNull();
		expect(devices.items).toHaveLength(1);
	});

	it('removes one device from the list after its session is revoked', async () => {
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [device('ses_a', true), device('ses_b')] } },
			[`DELETE ${listPath}/ses_b`]: { status: 204, body: null }
		});
		const devices = useDevicesStore();
		await devices.load();

		await devices.revoke('ses_b');

		expect(calls.at(-1)?.method).toBe('DELETE');
		expect(devices.items?.map((item) => item.id)).toEqual(['ses_a']);
	});

	it('keeps the list and throws the server error when a revoke is refused', async () => {
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [device('ses_a', true), device('ses_b')] } },
			[`DELETE ${listPath}/ses_b`]: failure('not_found', 'Not found', 'req_dev2')
		});
		const devices = useDevicesStore();
		await devices.load();

		await expect(devices.revoke('ses_b')).rejects.toMatchObject({ message: 'Not found' });
		expect(devices.items).toHaveLength(2);
	});

	it('keeps only the current device after revoking every other one', async () => {
		cleanup = registerApi({
			[`GET ${listPath}`]: {
				body: { items: [device('ses_a', true), device('ses_b'), device('ses_c')] }
			},
			[`DELETE ${listPath}`]: { status: 204, body: null }
		});
		const devices = useDevicesStore();
		await devices.load();

		await devices.revokeOthers();

		expect(devices.items?.map((item) => item.id)).toEqual(['ses_a']);
	});
});
