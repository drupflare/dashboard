import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ApiKeysPage from '~/pages/org/api-keys.vue';
import { claudeMcpAddCommand, type KeyView } from '~/shared/api-keys';
import { useApiKeysStore } from '~/stores/api-keys';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { clearBrowserState, failure, registerApi, type Reply } from '../stores/store-support';

const ORG = 'org_personal';
const keysKey = `GET /api/v1/orgs/${ORG}/api-keys`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const key = (id: string, over: Partial<KeyView> = {}): KeyView => ({
	id,
	name: `key ${id}`,
	prefix: `dfk_${id}`,
	scopes: ['org.read', 'site.read'],
	createdAt: '2026-11-01T10:00:00.000Z',
	lastUsedAt: null,
	expiresAt: null,
	revokedAt: null,
	...over
});

let cleanup: () => void = () => undefined;
let keysReply: (cursor: string | undefined) => Reply | Promise<Reply>;
let role = 'owner';
const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Personal', personal: true, role }], nextCursor: null }
		},
		[keysKey]: (call) => keysReply(call.query.cursor)
	});
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(ApiKeysPage, { route: '/org/api-keys' });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useApiKeysStore().$reset();
	role = 'owner';
	keysReply = () => ({ body: { items: [], nextCursor: null } });
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('api keys page', () => {
	it('shows skeletons until the first page arrives, then the empty state and the create button', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		keysReply = async () => {
			await gate;
			return { body: { items: [], nextCursor: null } };
		};
		const wrapper = await mountPage();
		expect(wrapper.find('[role="status"]').text()).toBe('Loading keys');
		expect(wrapper.text()).not.toContain('No Keys Yet');
		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Keys Yet'));
		expect(wrapper.findAll('button').some((button) => button.text() === 'Create a Key')).toBe(
			true
		);
	});

	it('lists each key with its prefix, last use, status and a revoke button on active keys only', async () => {
		keysReply = () => ({
			body: {
				items: [
					key('a', { lastUsedAt: '2026-11-12T09:30:00.000Z' }),
					key('b', { revokedAt: '2026-11-10T00:00:00.000Z' }),
					key('c', { expiresAt: '2026-01-01T00:00:00.000Z' }),
					key('d', { prefix: null })
				],
				nextCursor: null
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(4));
		const rows = wrapper.findAll('tbody tr').map((row) => row.text());
		expect(rows[0]).toContain('key a');
		expect(rows[0]).toContain('dfk_a');
		expect(rows[0]).toContain('Active');
		expect(rows[0]).not.toMatch(/Last Used.*Never/);
		expect(rows[1]).toContain('Revoked');
		expect(rows[2]).toContain('Expired');
		expect(rows[3]).toContain('Unavailable');
		const revokes = wrapper.findAll('tbody button').filter((b) => b.text() === 'Revoke');
		expect(revokes).toHaveLength(2);
		expect(wrapper.text()).toContain('Never');
	});

	it('shows the connect line built from the command builder, with no key in it', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('[data-command]').exists()).toBe(true));
		expect(wrapper.find('[data-command]').text()).toBe(claudeMcpAddCommand());
		expect(wrapper.find('[data-command]').text()).not.toContain('dfk_');
	});

	it('loads the next page on request', async () => {
		keysReply = (cursor) =>
			cursor === undefined
				? { body: { items: [key('a')], nextCursor: 'next' } }
				: { body: { items: [key('b')], nextCursor: null } };
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(1));
		const more = wrapper.findAll('button').find((button) => button.text() === 'Load More');
		await more!.trigger('click');
		await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(2));
		expect(wrapper.text()).not.toContain('Load More');
	});

	it('keeps the list and says so when a later page fails', async () => {
		keysReply = (cursor) =>
			cursor === undefined
				? { body: { items: [key('a')], nextCursor: 'next' } }
				: failure('internal', 'Failed', 'req_more');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(1));
		const more = wrapper.findAll('button').find((button) => button.text() === 'Load More');
		await more!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could not load more keys.'));
		expect(wrapper.findAll('tbody tr')).toHaveLength(1);
	});

	it('shows the error with a request id, then recovers on retry', async () => {
		keysReply = () => failure('internal', 'Failed', 'req_keys');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Keys'));
		expect(wrapper.text()).toContain('req_keys');
		keysReply = () => ({ body: { items: [key('a')], nextCursor: null } });
		const retry = wrapper.findAll('button').find((button) => button.text() === 'Try Again');
		await retry!.trigger('click');
		await vi.waitFor(() => expect(wrapper.findAll('tbody tr')).toHaveLength(1));
	});

	it('says so for a role that cannot read keys, and never asks the server', async () => {
		role = 'viewer';
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your Role Cannot Manage Keys'));
		expect(wrapper.text()).not.toContain('Connect an AI Client');
		expect(useApiKeysStore().lists.size).toBe(0);
	});

	it('offers the create button to a developer', async () => {
		role = 'developer';
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Keys Yet'));
		expect(wrapper.findAll('button').some((button) => button.text() === 'Create a Key')).toBe(
			true
		);
	});

	it('says there is no organization when the account has none', async () => {
		useOrgStore().$reset();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'GET /api/v1/me/organizations': { body: { items: [], nextCursor: null } }
		});
		await useOrgStore().ensure();
		const wrapper = await mountSuspended(ApiKeysPage, { route: '/org/api-keys' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Organization Found'));
	});
});
