import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SelfManagedPage from '~/pages/new/self-managed.vue';
import type { PlaneConnectionView } from '~/shared/plane-connections';
import { useOrgStore } from '~/stores/org';
import { usePlanesStore } from '~/stores/planes';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const base = `/api/v1/orgs/${personal.id}/planes/cloudflare`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const TOKEN = 'user-token-value-0123456789';
const ACCOUNT = 'a'.repeat(32);

const connection = (over: Partial<PlaneConnectionView> = {}): PlaneConnectionView => ({
	id: 'pcn_1',
	provider: 'cloudflare',
	accountId: ACCOUNT,
	accountName: 'Campus Site',
	tokenKind: 'user',
	expiresOn: null,
	state: 'active',
	capabilities: [
		{
			id: 'scripts',
			label: 'Site scripts',
			state: 'granted',
			permission: 'Workers Scripts Edit',
			retryHint: null
		}
	],
	workersSubdomain: 'acme',
	narrowerToken: true,
	createdAt: 1,
	lastValidatedAt: 2,
	revokedAt: null,
	...over
});

const report = {
	status: 'active',
	kind: 'user',
	tokenId: 'tok_1',
	expiresOn: null,
	accounts: [{ id: ACCOUNT, name: 'Campus Site' }],
	account: { id: ACCOUNT, name: 'Campus Site' },
	capabilities: [
		{
			id: 'scripts',
			label: 'Site scripts',
			state: 'granted',
			permission: 'Workers Scripts Edit',
			retryHint: null
		}
	],
	canDownscope: true
};

let cleanup: () => void = () => undefined;
let listReply: () => Reply;
let connectReply: () => Reply;
let createReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	usePlanesStore().$reset();
	listReply = () => ({ body: { items: [] } });
	connectReply = () => ({
		status: 201,
		body: {
			connection: connection(),
			message:
				'Drupflare made a narrower token for this account and kept only that one, sealed.'
		}
	});
	createReply = () => ({ status: 202, body: { id: 'op_1', type: 'site.create' } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[`GET ${base}`]: () => listReply(),
		[`POST ${base}/probe`]: { body: report },
		[`POST ${base}`]: () => connectReply(),
		[`POST /api/v1/orgs/${personal.id}/sites`]: () => createReply()
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(SelfManagedPage, { route: '/new/self-managed' });
	mounted.push(wrapper);
	await vi.waitFor(() =>
		expect(calls.some((call) => call.method === 'GET' && call.path === base)).toBe(true)
	);
	await vi.waitFor(() => expect(usePlanesStore().connections.has(personal.id)).toBe(true));
	return wrapper;
}

async function checkToken(wrapper: Awaited<ReturnType<typeof mountPage>>) {
	await wrapper.find('#cloudflare-token').setValue(TOKEN);
	await wrapper.find('form').trigger('submit');
	await vi.waitFor(() => expect(wrapper.text()).toContain('Connect This Account'));
}

const post = (path: string) => calls.find((call) => call.method === 'POST' && call.path === path);

describe('the self-managed create page', () => {
	it('shows only the connect section while no account is connected', async () => {
		const wrapper = await mountPage();
		expect(wrapper.text()).toContain('Connect Your Cloudflare Account');
		expect(wrapper.text()).not.toContain('Create a Site');
		expect(wrapper.find('#self-managed-name').exists()).toBe(false);
	});

	it('shows the create form above the connect section when an account is connected', async () => {
		listReply = () => ({ body: { items: [connection()] } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('#self-managed-name').exists()).toBe(true));
		expect(wrapper.text()).toContain('Connect Another Account');
		expect(wrapper.text()).toContain('.acme.workers.dev');
	});

	it('checks a token, connects the account and then offers the create form', async () => {
		const wrapper = await mountPage();
		await checkToken(wrapper);
		const connect = wrapper
			.findAll('button')
			.find((button) => button.text() === 'Connect This Account');
		await connect!.trigger('click');
		await vi.waitFor(() => expect(wrapper.find('#self-managed-name').exists()).toBe(true));
		expect(post(base)?.body).toEqual({ token: TOKEN, accountId: ACCOUNT });
		expect(wrapper.text()).toContain('narrower token for this account');
		expect((wrapper.find('#cloudflare-token').element as HTMLInputElement).value).toBe('');
		expect(wrapper.text()).not.toContain(TOKEN);
	});

	it('shows the connect refusal in words and keeps the token for a retry', async () => {
		connectReply = () => ({
			status: 409,
			body: {
				code: 'conflict',
				message: 'This Cloudflare account is already connected.',
				details: { reason: 'already_connected' },
				requestId: 'r1'
			}
		});
		const wrapper = await mountPage();
		await checkToken(wrapper);
		const connect = wrapper
			.findAll('button')
			.find((button) => button.text() === 'Connect This Account');
		await connect!.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('already connected')
		);
		expect(wrapper.find('#self-managed-name').exists()).toBe(false);
	});

	it('posts a self-managed create with an idempotency key and opens the progress page', async () => {
		listReply = () => ({ body: { items: [connection()] } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('#self-managed-name').exists()).toBe(true));
		await wrapper.find('#self-managed-name').setValue('calm-river-stone');
		await wrapper.find('form').trigger('submit');
		const path = `/api/v1/orgs/${personal.id}/sites`;
		await vi.waitFor(() => expect(post(path)).toBeDefined());
		expect(post(path)?.body).toEqual({
			kind: 'drupal',
			name: 'calm-river-stone',
			connectionId: 'pcn_1',
			plane: 'self-managed'
		});
		expect(post(path)?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
		await vi.waitFor(() =>
			expect(useRouter().currentRoute.value.path).toBe('/new/progress/op_1')
		);
	});

	it('shows a create refusal and sends a fresh idempotency key on the retry', async () => {
		listReply = () => ({ body: { items: [connection()] } });
		createReply = () => failure('unprocessable', 'The connection is not valid.', 'r2');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('#self-managed-name').exists()).toBe(true));
		await wrapper.find('#self-managed-name').setValue('calm-river-stone');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The connection is not valid.'));
		await wrapper.find('form').trigger('submit');
		const path = `/api/v1/orgs/${personal.id}/sites`;
		await vi.waitFor(() =>
			expect(
				calls.filter((call) => call.method === 'POST' && call.path === path)
			).toHaveLength(2)
		);
		const keys = calls
			.filter((call) => call.method === 'POST' && call.path === path)
			.map((call) => call.headers['idempotency-key']);
		expect(new Set(keys).size).toBe(2);
	});

	it('leaves no token behind when the page closes', async () => {
		const wrapper = await mountPage();
		await wrapper.find('#cloudflare-token').setValue(TOKEN);
		wrapper.unmount();
		mounted.length = 0;
		expect(JSON.stringify(usePlanesStore().$state)).not.toContain(TOKEN);
	});
});
