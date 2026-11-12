import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import Methods from '~/components/auth/Methods.vue';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const startAuthentication = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication }));

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	setup: () => () => h('div')
});

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
});

afterEach(() => {
	cleanup();
});

const buttons = (text: string) =>
	['GitHub', 'GitLab'].filter((name) => text.includes(`Continue with ${name}`));

describe('sign-in methods', () => {
	it('shows only the email code when no provider is set up', async () => {
		cleanup = registerApi({ 'GET /api/v1/auth/oauth': { body: { providers: [] } } });
		const wrapper = await mountSuspended(Methods);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(buttons(wrapper.text())).toEqual([]);
		expect(wrapper.find('input[name="email"]').exists()).toBe(true);
	});

	it('shows a button for each provider the server lists, and says why', async () => {
		cleanup = registerApi({
			'GET /api/v1/auth/oauth': { body: { providers: ['github', 'gitlab'] } }
		});
		const wrapper = await mountSuspended(Methods);
		await vi.waitFor(() => expect(buttons(wrapper.text())).toEqual(['GitHub', 'GitLab']));
		expect(wrapper.text()).toContain('It does not read your repositories');
	});

	it('names Cloudflare, says what it reads and says to connect it first', async () => {
		cleanup = registerApi({
			'GET /api/v1/auth/oauth': { body: { providers: ['cloudflare'] } }
		});
		const wrapper = await mountSuspended(Methods);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Continue with Cloudflare'));
		expect(wrapper.text()).toContain('reads no zones');
		expect(wrapper.text()).toContain('Connect Cloudflare from the Account page');
		expect(wrapper.text()).not.toContain('It does not read your repositories');
	});

	it('shows both texts when Cloudflare sits beside a provider that shares an email', async () => {
		cleanup = registerApi({
			'GET /api/v1/auth/oauth': { body: { providers: ['github', 'cloudflare'] } }
		});
		const wrapper = await mountSuspended(Methods);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Continue with GitHub'));
		expect(wrapper.text()).toContain('It does not read your repositories');
		expect(wrapper.text()).toContain('reads no zones');
	});

	it('shows only the providers the server lists', async () => {
		cleanup = registerApi({ 'GET /api/v1/auth/oauth': { body: { providers: ['gitlab'] } } });
		const wrapper = await mountSuspended(Methods);
		await vi.waitFor(() => expect(buttons(wrapper.text())).toEqual(['GitLab']));
	});

	it('keeps the email code and shows no provider when the list cannot be read', async () => {
		cleanup = registerApi({
			'GET /api/v1/auth/oauth': {
				status: 500,
				body: { code: 'internal', message: 'down', details: {}, requestId: 'r' }
			}
		});
		const wrapper = await mountSuspended(Methods);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(buttons(wrapper.text())).toEqual([]);
		expect(wrapper.find('input[name="email"]').exists()).toBe(true);
	});

	describe('passkey sign-in', () => {
		const PASSKEY_BUTTON = 'Sign In With a Passkey';
		const options = { challenge: 'abc', rpId: 'localhost' };
		const assertion = { id: 'cred_1', rawId: 'cred_1', type: 'public-key', response: {} };
		const envelope = (status: number, code: string, message: string) => ({
			status,
			body: { code, message, details: {}, requestId: 'req_1' }
		});

		function setSupport(supported: boolean) {
			if (supported) {
				Object.defineProperty(window, 'PublicKeyCredential', {
					value: function PublicKeyCredential() {},
					configurable: true,
					writable: true
				});
			} else {
				Reflect.deleteProperty(window, 'PublicKeyCredential');
			}
		}

		beforeEach(() => {
			navigate.mockReset();
			startAuthentication.mockReset();
			setSupport(true);
		});

		afterEach(() => {
			setSupport(false);
		});

		it('hides the passkey button when the browser has no passkey support', async () => {
			setSupport(false);
			cleanup = registerApi({ 'GET /api/v1/auth/oauth': { body: { providers: [] } } });
			const wrapper = await mountSuspended(Methods);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(wrapper.text()).not.toContain(PASSKEY_BUTTON);
			expect(wrapper.find('input[name="email"]').exists()).toBe(true);
		});

		it('shows the passkey button beside the email code when the browser supports passkeys', async () => {
			cleanup = registerApi({ 'GET /api/v1/auth/oauth': { body: { providers: [] } } });
			const wrapper = await mountSuspended(Methods);
			await vi.waitFor(() => expect(wrapper.text()).toContain(PASSKEY_BUTTON));
			expect(wrapper.find('input[name="email"]').exists()).toBe(true);
		});

		it('signs in, then goes to the sites list', async () => {
			startAuthentication.mockResolvedValue(assertion);
			cleanup = registerApi({
				'GET /api/v1/auth/oauth': { body: { providers: [] } },
				'POST /api/v1/auth/passkey/options': { body: options },
				'POST /api/v1/auth/passkey/verify': {
					body: {
						user: { id: 'usr_1', email: 'a@example.test', displayName: null },
						isNew: false
					}
				},
				'GET /api/v1/me': {
					body: {
						id: 'usr_1',
						email: 'a@example.test',
						displayName: null,
						via: 'session',
						stepUpUntil: null
					}
				}
			});
			const wrapper = await mountSuspended(Methods);
			await vi.waitFor(() => expect(wrapper.text()).toContain(PASSKEY_BUTTON));
			const button = wrapper.findAll('button').find((item) => item.text() === PASSKEY_BUTTON);
			await button!.trigger('click');

			await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/sites'));
			expect(startAuthentication).toHaveBeenCalledWith({ optionsJSON: options });
			expect(calls.find((call) => call.path.endsWith('/verify'))?.body).toEqual(assertion);
		});

		it('returns to the form with a calm line when the prompt is cancelled', async () => {
			startAuthentication.mockRejectedValue(
				Object.assign(new Error('cancelled'), { name: 'NotAllowedError' })
			);
			cleanup = registerApi({
				'GET /api/v1/auth/oauth': { body: { providers: [] } },
				'POST /api/v1/auth/passkey/options': { body: options }
			});
			const wrapper = await mountSuspended(Methods);
			await vi.waitFor(() => expect(wrapper.text()).toContain(PASSKEY_BUTTON));
			const button = wrapper.findAll('button').find((item) => item.text() === PASSKEY_BUTTON);
			await button!.trigger('click');

			await vi.waitFor(() =>
				expect(wrapper.text()).toContain(
					'No passkey was used. You can try again or sign in another way.'
				)
			);
			expect(wrapper.find('[role="alert"]').exists()).toBe(false);
			expect(wrapper.find('input[name="email"]').exists()).toBe(true);
			expect(calls.some((call) => call.path.endsWith('/verify'))).toBe(false);
			expect(navigate).not.toHaveBeenCalled();
		});

		it('shows the server message when the passkey cannot be verified', async () => {
			startAuthentication.mockResolvedValue(assertion);
			cleanup = registerApi({
				'GET /api/v1/auth/oauth': { body: { providers: [] } },
				'POST /api/v1/auth/passkey/options': { body: options },
				'POST /api/v1/auth/passkey/verify': envelope(
					401,
					'unauthenticated',
					'The passkey could not be verified'
				)
			});
			const wrapper = await mountSuspended(Methods);
			await vi.waitFor(() => expect(wrapper.text()).toContain(PASSKEY_BUTTON));
			const button = wrapper.findAll('button').find((item) => item.text() === PASSKEY_BUTTON);
			await button!.trigger('click');

			await vi.waitFor(() =>
				expect(wrapper.find('[role="alert"]').text()).toContain(
					'The passkey could not be verified'
				)
			);
			expect(navigate).not.toHaveBeenCalled();
		});
	});
});
