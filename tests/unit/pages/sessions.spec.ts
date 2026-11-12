import { mockComponent, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import SessionsPage from '~/pages/account/sessions.vue';
import { useDevicesStore, type Device } from '~/stores/devices';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from '../stores/store-support';

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	setup(_props: unknown, { expose }: { expose: (value: object) => void }) {
		expose({ reset: () => undefined });
		return () => h('div');
	}
});

const current: Device = {
	id: 'ses_cur',
	device: 'Firefox on Linux',
	ip: '203.0.113.0/24',
	createdAt: '2026-11-01T12:00:00.000Z',
	lastSeenAt: '2026-11-10T12:00:00.000Z',
	current: true
};
const other: Device = {
	id: 'ses_old',
	device: 'Safari on iOS',
	ip: null,
	createdAt: '2026-10-20T08:00:00.000Z',
	lastSeenAt: '2026-11-02T08:00:00.000Z',
	current: false
};

const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

const listPath = '/api/v1/me/sessions';
let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

function signIn(stepUpUntil: string | null) {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil
	};
}

async function mountPage() {
	const wrapper = await mountSuspended(SessionsPage);
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: { findAll: (selector: string) => any[] }, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text().includes(text));

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useDevicesStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('signed-in devices page', () => {
	it('marks the current device and lists the others without raw session ids', async () => {
		signIn(soon());
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [current, other], nextCursor: null } }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Safari on iOS'));
		expect(wrapper.text()).toContain('This Device');
		expect(wrapper.text()).not.toContain('ses_cur');
		expect(wrapper.text()).not.toContain('ses_old');
		expect(button(wrapper, 'Sign Out Everywhere Else')).toBeTruthy();
	});

	it('signs out one other device and drops its row', async () => {
		signIn(soon());
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [current, other], nextCursor: null } },
			[`DELETE ${listPath}/ses_old`]: { status: 204, body: null }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Safari on iOS'));

		await button(wrapper, 'Sign Out')!.trigger('click');

		await vi.waitFor(() => expect(wrapper.text()).not.toContain('Safari on iOS'));
		expect(calls.at(-1)?.method).toBe('DELETE');
		expect(calls.at(-1)?.path).toBe(`${listPath}/ses_old`);
	});

	it('signs out every other device and keeps the current one', async () => {
		signIn(soon());
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [current, other], nextCursor: null } },
			[`DELETE ${listPath}`]: { status: 204, body: null }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Safari on iOS'));

		await button(wrapper, 'Sign Out Everywhere Else')!.trigger('click');

		await vi.waitFor(() => expect(wrapper.text()).not.toContain('Safari on iOS'));
		expect(wrapper.text()).toContain('Firefox on Linux');
		expect(button(wrapper, 'Sign Out Everywhere Else')).toBeUndefined();
	});

	it('asks for a code before ending sessions when the sign-in is stale, then ends them', async () => {
		signIn(past());
		let fresh = false;
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [current, other], nextCursor: null } },
			[`DELETE ${listPath}`]: { status: 204, body: null },
			'GET /api/v1/me': () => ({
				body: {
					id: 'usr_1',
					email: 'owner@example.test',
					displayName: null,
					via: 'session',
					stepUpUntil: fresh ? soon() : past()
				}
			}),
			'POST /api/v1/auth/code/request': { status: 204, body: null },
			'POST /api/v1/auth/step-up': () => {
				fresh = true;
				return { body: { stepUpUntil: soon() } };
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Safari on iOS'));

		await button(wrapper, 'Sign Out Everywhere Else')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		expect(calls.some((call) => call.method === 'DELETE')).toBe(false);

		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.find('#step-up-code').exists()).toBe(true));
		await wrapper.find('#step-up-code').setValue('123456');
		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() => expect(wrapper.text()).not.toContain('Safari on iOS'));
		expect(calls.some((call) => call.method === 'DELETE' && call.path === listPath)).toBe(true);
	});

	it('says so when the list is empty', async () => {
		signIn(soon());
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [], nextCursor: null } }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Signed-In Devices'));
	});

	it('shows the server message when the list cannot load', async () => {
		signIn(soon());
		cleanup = registerApi({
			[`GET ${listPath}`]: failure('internal', 'The devices could not be listed', 'req_ls')
		});
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain(
				'The devices could not be listed'
			)
		);
	});

	it('shows the server message when a sign out is refused and keeps the row', async () => {
		signIn(soon());
		cleanup = registerApi({
			[`GET ${listPath}`]: { body: { items: [current, other], nextCursor: null } },
			[`DELETE ${listPath}/ses_old`]: failure('internal', 'Could not sign out', 'req_rv')
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Safari on iOS'));

		await button(wrapper, 'Sign Out')!.trigger('click');

		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('Could not sign out')
		);
		expect(wrapper.text()).toContain('Safari on iOS');
	});
});
