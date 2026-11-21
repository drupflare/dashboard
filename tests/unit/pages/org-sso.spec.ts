import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SsoPage from '~/pages/org/sso.vue';
import type { SsoView } from '~/shared/sso';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { useSsoStore } from '~/stores/sso';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const path = `/api/v1/orgs/${ORG}/sso`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const saved: SsoView = {
	configured: true,
	slug: 'example-edu',
	issuer: 'https://idp.example.edu',
	clientId: 'client-1',
	secretSet: true,
	allowedDomains: ['example.edu'],
	roleMap: [{ group: 'web-admins', role: 'admin' }],
	groupClaim: 'groups',
	defaultRole: 'viewer',
	enabled: false,
	lastVerifiedAt: null,
	redirectUri: 'https://app.example.test/api/v1/auth/sso/example-edu/callback'
};

let cleanup: () => void = () => undefined;
let role = 'owner';
let current: SsoView = saved;
const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Campus', personal: false, role }], nextCursor: null }
		},
		[`GET ${path}`]: () => ({ body: current }),
		[`PUT ${path}`]: (call) => {
			current = { ...current, ...(call.body as object) } as SsoView;
			return { body: current };
		},
		[`POST ${path}/test`]: () => ({ body: { ok: true, message: 'The provider answered.' } })
	});
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(SsoPage, { route: '/org/sso' });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useSsoStore().$reset();
	role = 'owner';
	current = saved;
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('organization sign-in page', () => {
	it('fills the form from the saved settings and shows the redirect address and role rows', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect((wrapper.find('input[name="issuer"]').element as HTMLInputElement).value).toBe(
				saved.issuer
			)
		);
		expect(wrapper.find('[data-test="redirect-uri"]').text()).toBe(saved.redirectUri);
		expect((wrapper.find('input[name="group"]').element as HTMLInputElement).value).toBe(
			'web-admins'
		);
		const secret = wrapper.find('input[name="clientSecret"]').element as HTMLInputElement;
		expect(secret.value).toBe('');
		expect(wrapper.text()).toContain('A secret is stored');
	});

	it('saves without a secret when the field is empty and sends one when it is filled', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="issuer"]').exists()).toBe(true));
		await vi.waitFor(() =>
			expect((wrapper.find('input[name="slug"]').element as HTMLInputElement).value).toBe(
				'example-edu'
			)
		);
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
		const first = calls.find((call) => call.method === 'PUT')?.body as Record<string, unknown>;
		expect(first).not.toHaveProperty('clientSecret');
		expect(first).toMatchObject({
			allowedDomains: ['example.edu'],
			roleMap: [{ group: 'web-admins', role: 'admin' }]
		});

		await wrapper.find('input[name="clientSecret"]').setValue('new-secret');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(calls.filter((call) => call.method === 'PUT')).toHaveLength(2)
		);
		const second = calls.filter((call) => call.method === 'PUT')[1]?.body;
		expect(second).toMatchObject({ clientSecret: 'new-secret' });
		expect(wrapper.html()).not.toContain('new-secret');
	});

	it('shows the result of the connection test', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('input[name="issuer"]').exists()).toBe(true));
		const test = wrapper
			.findAll('button')
			.find((button) => button.text() === 'Test the Connection');
		await vi.waitFor(() => expect(test?.attributes('disabled')).toBeUndefined());
		await test?.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="test-result"]').text()).toContain('The test passed.')
		);
	});

	it('tells a role that cannot manage sign-in to ask an owner, without loading the settings', async () => {
		role = 'developer';
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Only an Owner Can Change This'));
		expect(calls.some((call) => call.path === path)).toBe(false);
	});
});
