import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import Connections from '~/components/account/Connections.vue';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

mockComponent('NuxtTurnstile', {
	props: { modelValue: String },
	setup(_props: unknown, { expose }: { expose: (value: object) => void }) {
		expose({ reset: () => undefined });
		return () => h('div');
	}
});

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ID = '3f2b8c1e-5a47-4d59-9b1e-0a3c5d7e9f11';
const identity = {
	id: ID,
	provider: 'github',
	email: 'ada@example.test',
	verified: true,
	createdAt: '2026-11-01T12:00:00.000Z'
};

const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();
const past = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();

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

const api = (items: unknown[] = [], providers = ['github', 'cloudflare']) => ({
	'GET /api/v1/me/identities': () => ({ body: { items, nextCursor: null } }),
	'GET /api/v1/auth/oauth': { body: { providers } }
});

async function mountPanel(props: Record<string, unknown> = {}) {
	const wrapper = await mountSuspended(Connections, { props });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: { findAll: (selector: string) => any[] }, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text().includes(text));

beforeEach(() => {
	navigate.mockReset();
	clearBrowserState();
	useSessionStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('connected accounts', () => {
	it('shows row-shaped skeletons until the list arrives', async () => {
		signIn(null);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		cleanup = registerApi({
			'GET /api/v1/me/identities': async () => {
				await gate;
				return { body: { items: [], nextCursor: null } };
			},
			'GET /api/v1/auth/oauth': { body: { providers: ['github'] } }
		});
		const wrapper = await mountPanel();
		const loading = wrapper.find('[role="status"]');
		expect(loading.text()).toBe('Loading connected accounts');
		expect(loading.findAll('.animate-pulse').length).toBeGreaterThan(2);
		expect(wrapper.text()).not.toContain('Loading...');

		release();
		await vi.waitFor(() => expect(wrapper.find('[role="status"]').exists()).toBe(false));
	});

	it('lists each provider that is set up, connected or not', async () => {
		signIn(soon());
		cleanup = registerApi(api([identity]));
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.findAll('li').length).toBeGreaterThan(1));
		const rows = wrapper.findAll('ul > li').map((row) => row.text());
		expect(rows.some((row) => row.startsWith('GitHub'))).toBe(true);
		expect(rows.some((row) => row.startsWith('Cloudflare'))).toBe(true);
		expect(wrapper.text()).toContain('Connected as ada@example.test');
		expect(wrapper.text()).toContain('Not connected');
		expect(button(wrapper, 'Connect Another')).toBeTruthy();
		expect(button(wrapper, 'Remove')).toBeTruthy();
	});

	it('keeps a connected provider that has since been switched off, with no way to connect more', async () => {
		signIn(soon());
		cleanup = registerApi(api([identity], ['cloudflare']));
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('GitHub'));
		expect(button(wrapper, 'Connect Another')).toBeUndefined();
		expect(button(wrapper, 'Remove')).toBeTruthy();
	});

	it('says so when no provider is set up', async () => {
		signIn(soon());
		cleanup = registerApi(api([], []));
		const wrapper = await mountPanel();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('No sign-in providers are available')
		);
	});

	it('confirms a connection that just finished', async () => {
		signIn(soon());
		cleanup = registerApi(api());
		const wrapper = await mountPanel({ justConnected: 'cloudflare' });
		expect(wrapper.find('[role="status"]').text()).toContain('Cloudflare is connected');
	});
});

describe('connecting', () => {
	it('starts the provider flow straight away when the session is fresh', async () => {
		signIn(soon());
		cleanup = registerApi({
			...api(),
			'POST /api/v1/me/identities/connect/cloudflare/start': {
				body: { url: 'https://dash.cloudflare.com/oauth2/auth?x=1', consent: 'text' }
			}
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Connect')).toBeTruthy());
		const cloudflare = wrapper
			.findAll('li')
			.find((row) => row.text().startsWith('Cloudflare'))!;
		await cloudflare.find('button').trigger('click');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://dash.cloudflare.com/oauth2/auth?x=1', {
				external: true
			})
		);
		expect(wrapper.text()).not.toContain('Confirm Your Identity');
	});

	it('asks for a code first when the session is not fresh, then connects', async () => {
		signIn(past());
		let fresh = false;
		cleanup = registerApi({
			...api(),
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
			},
			'POST /api/v1/me/identities/connect/cloudflare/start': {
				body: { url: 'https://dash.cloudflare.com/oauth2/auth?y=2', consent: 'text' }
			}
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Connect')).toBeTruthy());
		const cloudflare = wrapper
			.findAll('li')
			.find((row) => row.text().startsWith('Cloudflare'))!;
		await cloudflare.find('button').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		expect(calls.some((call) => call.path.endsWith('/start'))).toBe(false);

		await button(wrapper, 'Send Code')!.trigger('submit');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.find('#step-up-code').exists()).toBe(true));
		expect(calls.find((call) => call.path === '/api/v1/auth/code/request')?.body).toMatchObject(
			{
				email: 'owner@example.test'
			}
		);

		await wrapper.find('#step-up-code').setValue('123456');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(navigate).toHaveBeenCalledWith('https://dash.cloudflare.com/oauth2/auth?y=2', {
				external: true
			})
		);
		expect(calls.find((call) => call.path === '/api/v1/auth/step-up')?.body).toEqual({
			code: '123456'
		});
		expect(wrapper.text()).not.toContain('Confirm Your Identity');
	});

	it('checks the code is six digits before it asks the server', async () => {
		signIn(past());
		cleanup = registerApi({
			...api(),
			'POST /api/v1/auth/code/request': { status: 204, body: null }
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Connect')).toBeTruthy());
		await wrapper.findAll('li')[0]!.find('button').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.find('#step-up-code').exists()).toBe(true));
		await wrapper.find('#step-up-code').setValue('12');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('six-digit code'));
		expect(calls.some((call) => call.path === '/api/v1/auth/step-up')).toBe(false);
	});

	it('drops the code panel on cancel and starts nothing', async () => {
		signIn(past());
		cleanup = registerApi(api());
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Connect')).toBeTruthy());
		await wrapper.findAll('li')[0]!.find('button').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		await button(wrapper, 'Cancel')!.trigger('click');
		expect(wrapper.text()).not.toContain('Confirm Your Identity');
		expect(navigate).not.toHaveBeenCalled();
	});

	it('shows the server message when the connection cannot start', async () => {
		signIn(soon());
		cleanup = registerApi({
			...api(),
			'POST /api/v1/me/identities/connect/cloudflare/start': {
				status: 501,
				body: {
					code: 'not_built',
					message: 'This sign-in method is not configured',
					details: {},
					requestId: 'r'
				}
			}
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Connect')).toBeTruthy());
		const cloudflare = wrapper
			.findAll('li')
			.find((row) => row.text().startsWith('Cloudflare'))!;
		await cloudflare.find('button').trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('not configured')
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('asks for a code when the server says the session is no longer fresh', async () => {
		signIn(soon());
		cleanup = registerApi({
			...api(),
			'POST /api/v1/me/identities/connect/cloudflare/start': {
				status: 403,
				body: {
					code: 'forbidden',
					message: 'Fresh authentication is required',
					details: { requires: 'step-up' },
					requestId: 'r'
				}
			}
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Connect')).toBeTruthy());
		const cloudflare = wrapper
			.findAll('li')
			.find((row) => row.text().startsWith('Cloudflare'))!;
		await cloudflare.find('button').trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Confirm Your Identity'));
		expect(wrapper.find('[role="alert"]').exists()).toBe(false);
	});
});

describe('removing a connection', () => {
	it('removes it with a fresh session and lists again', async () => {
		signIn(soon());
		let items: unknown[] = [identity];
		cleanup = registerApi({
			'GET /api/v1/me/identities': () => ({ body: { items, nextCursor: null } }),
			'GET /api/v1/auth/oauth': { body: { providers: ['github'] } },
			[`DELETE /api/v1/me/identities/${ID}`]: () => {
				items = [];
				return { status: 204, body: null };
			}
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Remove')).toBeTruthy());
		await button(wrapper, 'Remove')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Not connected'));
		expect(calls.map((call) => `${call.method} ${call.path}`)).toContain(
			`DELETE /api/v1/me/identities/${ID}`
		);
	});

	it('shows the message when it is the last sign-in method', async () => {
		signIn(soon());
		cleanup = registerApi({
			...api([identity], ['github']),
			[`DELETE /api/v1/me/identities/${ID}`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'This is your last sign-in method, so it cannot be removed',
					details: {},
					requestId: 'r'
				}
			}
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(button(wrapper, 'Remove')).toBeTruthy());
		await button(wrapper, 'Remove')!.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('last sign-in method')
		);
	});
});

describe('loading', () => {
	it('shows the message and an empty list when the lists cannot be read', async () => {
		signIn(soon());
		cleanup = registerApi({
			'GET /api/v1/me/identities': {
				status: 500,
				body: { code: 'internal', message: 'down', details: {}, requestId: 'r' }
			},
			'GET /api/v1/auth/oauth': { body: { providers: ['github'] } }
		});
		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.find('[role="alert"]').text()).toContain('down'));
		expect(wrapper.text()).not.toContain('Loading');
	});
});
