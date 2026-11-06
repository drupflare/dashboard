import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import LoginPage from '~/pages/login.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	emits: ['update:modelValue'],
	setup(_props, { emit, expose }) {
		emit('update:modelValue', 'turnstile-token');
		expose({ reset: () => undefined });
		return () => h('div', { 'data-test': 'turnstile' });
	}
});

const email = 'owner@example.test';
const me = { id: 'usr_1', email, displayName: null, via: 'session', stepUpUntil: null };
const unauthenticated = {
	status: 401,
	body: {
		code: 'unauthenticated',
		message: 'Authentication is required',
		details: {},
		requestId: 'req_me'
	}
};

let signedIn = false;
let cleanup: () => void = () => undefined;

beforeEach(() => {
	navigate.mockClear();
	clearBrowserState();
	signedIn = false;
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
});

const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	const wrapper = await mountSuspended(LoginPage, { route: '/login' });
	mounted.push(wrapper);
	return wrapper;
}

async function submitEmail(wrapper: Awaited<ReturnType<typeof mountPage>>) {
	await wrapper.find('input[name="email"]').setValue(email);
	await wrapper.find('form').trigger('submit');
}

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('login page', () => {
	it('signs in with the emailed code and goes to the sites page', async () => {
		cleanup = registerApi({
			'GET /api/v1/me': () => (signedIn ? { body: me } : unauthenticated),
			'POST /api/v1/auth/code/request': { status: 202, body: { sent: true } },
			'POST /api/v1/auth/code/verify': () => {
				signedIn = true;
				return { body: { user: { id: 'usr_1', email, displayName: null }, isNew: false } };
			}
		});

		const wrapper = await mountPage();
		await submitEmail(wrapper);
		await vi.waitFor(() => expect(wrapper.find('input[name="code"]').exists()).toBe(true));

		expect(calls.find((call) => call.path === '/api/v1/auth/code/request')?.body).toEqual({
			email,
			turnstileToken: 'turnstile-token'
		});
		await wrapper.find('input[name="code"]').setValue('123456');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/sites'));

		expect(calls.find((call) => call.path === '/api/v1/auth/code/verify')?.body).toEqual({
			email,
			code: '123456'
		});
	});

	it('shows the server message for a wrong code beside the code field', async () => {
		cleanup = registerApi({
			'POST /api/v1/auth/code/request': { status: 202, body: { sent: true } },
			'POST /api/v1/auth/code/verify': {
				status: 401,
				body: {
					code: 'unauthenticated',
					message: 'The code is invalid or has expired',
					details: {},
					requestId: 'req_verify'
				}
			}
		});

		const wrapper = await mountPage();
		await submitEmail(wrapper);
		await vi.waitFor(() => expect(wrapper.find('input[name="code"]').exists()).toBe(true));
		await wrapper.find('input[name="code"]').setValue('000000');
		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() =>
			expect(wrapper.find('#sign-in-code-error').text()).toContain(
				'The code is invalid or has expired'
			)
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('shows the rate limit as a wait message beside the email field', async () => {
		cleanup = registerApi({
			'POST /api/v1/auth/code/request': {
				status: 429,
				body: {
					code: 'rate_limited',
					message: 'Too many codes requested for this address',
					details: { retryAfterSeconds: 120 },
					requestId: 'req_rate'
				}
			}
		});

		const wrapper = await mountPage();
		await submitEmail(wrapper);

		await vi.waitFor(() =>
			expect(wrapper.find('#sign-in-email-error').text()).toBe(
				'Too many codes requested for this address. Try again in 120 seconds.'
			)
		);
	});
});
