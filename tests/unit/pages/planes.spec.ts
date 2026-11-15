import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PlanesPage from '~/pages/planes/index.vue';
import { useNodesStore } from '~/stores/nodes';
import { useOrgStore } from '~/stores/org';
import { usePlanesStore } from '~/stores/planes';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, failure, registerApi, type Reply } from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const nodesKey = `GET /api/v1/orgs/${personal.id}/nodes`;
const connectionsKey = `GET /api/v1/orgs/${personal.id}/planes/cloudflare`;

function connectionRow(over: Record<string, unknown> = {}) {
	return {
		id: 'pcn_1',
		provider: 'cloudflare',
		accountId: 'a'.repeat(32),
		accountName: 'Campus Site',
		tokenKind: 'user',
		expiresOn: null,
		state: 'active',
		capabilities: [
			{
				id: 'scripts',
				label: 'Workers Scripts',
				state: 'granted',
				permission: 'x',
				retryHint: null
			}
		],
		workersSubdomain: 'acme',
		narrowerToken: true,
		createdAt: 1_790_000_000_000,
		lastValidatedAt: 1_790_000_100_000,
		revokedAt: null,
		...over
	};
}
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

function node(id: string, state: 'active' | 'revoked' = 'active') {
	return {
		id,
		state,
		name: `box-${id}`,
		os: 'linux',
		arch: 'x64',
		bastionVersion: '0.1.0',
		workerdVersion: '1.2',
		mode: 'standalone',
		pairedAt: '2026-11-01T10:00:00.000Z',
		lastSeenAt: null,
		revokedAt: null
	};
}

let cleanup: () => void = () => undefined;
let nodesReply: (cursor: string | undefined) => Reply | Promise<Reply>;
let meReply: () => Reply;
let connectionsReply: () => Reply;

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useNodesStore().$reset();
	usePlanesStore().$reset();
	nodesReply = () => ({ body: { items: [], nextCursor: null } });
	connectionsReply = () => ({ body: { items: [] } });
	meReply = () => ({ body: me });
	cleanup = registerApi({
		'GET /api/v1/me': () => meReply(),
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[nodesKey]: (call) => nodesReply(call.query.cursor),
		[connectionsKey]: () => connectionsReply()
	});
	await useOrgStore().ensure();
});

const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	const wrapper = await mountSuspended(PlanesPage, { route: '/planes' });
	mounted.push(wrapper);
	return wrapper;
}

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('nodes page', () => {
	it('shows skeletons until the first page arrives, then the empty state', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		nodesReply = async () => {
			await gate;
			return { body: { items: [], nextCursor: null } };
		};
		const wrapper = await mountPage();
		expect(wrapper.find('[role="status"]').text()).toBe('Loading nodes');
		expect(wrapper.text()).not.toContain('No Nodes Yet');
		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Nodes Yet'));
		expect(wrapper.text()).toContain('Pair a Node');
	});

	it('lists each node and offers the pairing dialog', async () => {
		nodesReply = () => ({
			body: { items: [node('a'), node('b', 'revoked')], nextCursor: null }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('ul > li')).toHaveLength(2));
		expect(wrapper.text()).toContain('box-a');
		expect(wrapper.text()).toContain('Revoked');
		expect(wrapper.text()).toContain('Active');
		expect(wrapper.find('button').text()).toBe('Pair a Node');
	});

	it('loads the next page on request', async () => {
		nodesReply = (cursor) =>
			cursor === undefined
				? { body: { items: [node('a')], nextCursor: 'next' } }
				: { body: { items: [node('b')], nextCursor: null } };
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('ul > li')).toHaveLength(1));
		const more = wrapper.findAll('button').find((button) => button.text() === 'Load More');
		await more!.trigger('click');
		await vi.waitFor(() => expect(wrapper.findAll('ul > li')).toHaveLength(2));
		expect(wrapper.text()).not.toContain('Load More');
	});

	it('shows the error with a request id, then recovers on retry', async () => {
		nodesReply = () => failure('internal', 'Failed', 'req_nodes');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Nodes'));
		expect(wrapper.text()).toContain('req_nodes');
		nodesReply = () => ({ body: { items: [node('a')], nextCursor: null } });
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try Again');
		await retry!.trigger('click');
		await vi.waitFor(() => expect(wrapper.findAll('ul > li')).toHaveLength(1));
	});

	it('keeps the list and says so when a later page fails', async () => {
		nodesReply = (cursor) =>
			cursor === undefined
				? { body: { items: [node('a')], nextCursor: 'next' } }
				: failure('internal', 'Failed', 'req_more');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('ul > li')).toHaveLength(1));
		const more = wrapper.findAll('button').find((button) => button.text() === 'Load More');
		await more!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could not load more nodes.'));
		expect(wrapper.findAll('ul > li')).toHaveLength(1);
	});

	it('says no account is connected and links to the connect page', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Accounts Connected'));
		expect(wrapper.html()).toContain('/new/self-managed');
	});

	it('lists each connection with its state, last check, token kind and what it can use', async () => {
		connectionsReply = () => ({
			body: {
				items: [
					connectionRow(),
					connectionRow({
						id: 'pcn_2',
						accountName: 'Old Account',
						state: 'invalid',
						narrowerToken: false,
						tokenKind: 'account'
					}),
					connectionRow({
						id: 'pcn_3',
						accountName: 'Gone Account',
						state: 'revoked',
						revokedAt: 1_790_000_200_000
					})
				]
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Campus Site'));
		const text = wrapper.text();
		expect(text).toContain('Needs Attention');
		expect(text).toContain('Revoked');
		expect(text).toContain('Narrower token made by Drupflare');
		expect(text).toContain('Account token you gave');
		expect(text).toContain('Can use: Workers Scripts');
		expect(text).toContain('.acme.workers.dev');
		expect(text).toContain('Last Checked');
		const section = wrapper.find('section[aria-labelledby="plane-connections-title"]');
		const buttons = section.findAll('button').map((button) => button.text());
		expect(buttons.filter((label) => label === 'Revoke')).toHaveLength(2);
		expect(buttons.filter((label) => label === 'Check Again')).toHaveLength(2);
	});

	it('checks a connection again and shows the new state', async () => {
		connectionsReply = () => ({ body: { items: [connectionRow()] } });
		const stop = registerApi({
			[`POST /api/v1/orgs/${personal.id}/planes/cloudflare/pcn_1/validate`]: {
				body: connectionRow({ state: 'invalid' })
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Campus Site'));
		const again = wrapper.findAll('button').find((button) => button.text() === 'Check Again');
		await again!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Needs Attention'));
		expect(wrapper.text()).toContain('The stored token no longer works');
		stop();
	});

	it('shows the connection error with a way to retry', async () => {
		connectionsReply = () => failure('internal', 'Failed', 'req_conn');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Accounts'));
		expect(wrapper.text()).toContain('req_conn');
		connectionsReply = () => ({ body: { items: [connectionRow()] } });
		const retry = wrapper
			.findAll('button')
			.filter((button) => button.text() === 'Try Again')
			.at(0);
		await retry!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Campus Site'));
	});

	it('shows a session error with a way to retry', async () => {
		useSessionStore().$reset();
		meReply = () => failure('internal', 'The session failed', 'req_me');
		await useSessionStore().load();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Your Account'));
		expect(wrapper.text()).toContain('req_me');
	});
});
