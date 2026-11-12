import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import List from '~/components/account/session/List.vue';
import Row from '~/components/account/session/Row.vue';
import type { Device } from '~/stores/devices';

const device = (overrides: Partial<Device> = {}): Device => ({
	id: 'ses_a',
	device: 'Chrome on macOS',
	ip: '203.0.113.0/24',
	createdAt: '2026-11-01T12:00:00.000Z',
	lastSeenAt: '2026-11-10T12:00:00.000Z',
	current: false,
	...overrides
});

const mounted: { unmount: () => void }[] = [];

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
});

async function mountRow(props: { device: Device; busy?: boolean }) {
	const wrapper = await mountSuspended(Row, { props });
	mounted.push(wrapper);
	return wrapper;
}

describe('account session row', () => {
	it('marks the current device and offers no sign out for it', async () => {
		const wrapper = await mountRow({ device: device({ current: true }) });
		expect(wrapper.text()).toContain('This Device');
		expect(wrapper.find('button').exists()).toBe(false);
	});

	it('shows the device label, the last use and the network, with no session id', async () => {
		const wrapper = await mountRow({ device: device() });
		expect(wrapper.text()).toContain('Chrome on macOS');
		expect(wrapper.text()).toContain('Last used');
		expect(wrapper.text()).toContain('203.0.113.0/24');
		expect(wrapper.text()).not.toContain('ses_a');
		expect(wrapper.text()).not.toContain('This Device');
	});

	it('leaves out the network when the server has none', async () => {
		const wrapper = await mountRow({ device: device({ ip: null }) });
		expect(wrapper.text()).toContain('Last used');
		expect(wrapper.text()).not.toContain(' from ');
	});

	it('emits revoke when Sign Out is pressed', async () => {
		const wrapper = await mountRow({ device: device() });
		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('revoke')).toHaveLength(1);
	});
});

describe('account session list', () => {
	it('renders one row per device and marks only the busy one', async () => {
		const wrapper = await mountSuspended(List, {
			props: {
				items: [
					device({ current: true }),
					device({ id: 'ses_b', device: 'Firefox on Linux' })
				],
				busy: 'device:ses_b'
			}
		});
		mounted.push(wrapper);
		const rows = wrapper.findAll('li');
		expect(rows).toHaveLength(2);
		expect(rows[1]!.text()).toContain('Firefox on Linux');
		expect(rows[1]!.find('button').attributes('disabled')).toBeDefined();
	});

	it('passes the id of the row that was signed out', async () => {
		const wrapper = await mountSuspended(List, {
			props: { items: [device({ id: 'ses_b' })], busy: null }
		});
		mounted.push(wrapper);
		await wrapper.find('button').trigger('click');
		expect(wrapper.emitted('revoke')).toEqual([['ses_b']]);
	});
});
