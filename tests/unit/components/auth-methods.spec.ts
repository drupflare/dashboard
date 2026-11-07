import { mockComponent, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import Methods from '~/components/auth/Methods.vue';
import { clearBrowserState, registerApi } from '../stores/store-support';

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
});
