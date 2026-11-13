import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SelfHostedPage from '~/pages/new/self-hosted.vue';
import { LINK_STATE_COPY } from '~/shared/nodes';
import { useNodesStore } from '~/stores/nodes';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const nodesKey = `GET /api/v1/orgs/${personal.id}/nodes`;
const createKey = `POST /api/v1/orgs/${personal.id}/nodes/nod_live/sites`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

function node(id: string, lastSeenAt: string | null, state: 'active' | 'revoked' = 'active') {
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
		lastSeenAt,
		revokedAt: state === 'revoked' ? '2026-11-02T10:00:00.000Z' : null
	};
}

const fresh = () => new Date(Date.now() - 60_000).toISOString();
const stale = () => new Date(Date.now() - 3_600_000).toISOString();

let cleanup: () => void = () => undefined;
let nodesReply: () => Reply;
let createReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useNodesStore().$reset();
	nodesReply = () => ({
		body: {
			items: [node('nod_live', fresh()), node('nod_quiet', stale()), node('nod_new', null)],
			nextCursor: null
		}
	});
	createReply = () => ({ status: 202, body: { id: 'op_1', type: 'node.command' } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[nodesKey]: () => nodesReply(),
		[createKey]: () => createReply()
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(SelfHostedPage, { route: '/new/self-hosted' });
	mounted.push(wrapper);
	await vi.waitFor(() =>
		expect(wrapper.findAll('input[type="radio"]').length).toBeGreaterThan(0)
	);
	return wrapper;
}

describe('the self-hosted create page', () => {
	it('lists unconnected boxes with the reason and leaves them unselectable', async () => {
		const wrapper = await mountPage();
		const radios = wrapper.findAll('input[type="radio"]');
		expect(radios).toHaveLength(3);
		expect(radios.map((radio) => radio.attributes('disabled') !== undefined)).toEqual([
			false,
			true,
			true
		]);
		expect(wrapper.text()).toContain(LINK_STATE_COPY.quiet);
		expect(wrapper.text()).toContain(LINK_STATE_COPY.never);
	});

	it('hides unpaired boxes', async () => {
		nodesReply = () => ({
			body: {
				items: [node('nod_live', fresh()), node('nod_gone', fresh(), 'revoked')],
				nextCursor: null
			}
		});
		const wrapper = await mountPage();
		expect(wrapper.findAll('input[type="radio"]')).toHaveLength(1);
		expect(wrapper.text()).not.toContain('box-nod_gone');
	});

	it('says what is missing and sends nothing until the form is complete', async () => {
		const wrapper = await mountPage();
		await wrapper.find('form').trigger('submit');
		expect(wrapper.text()).toContain('Choose a connected box.');
		expect(wrapper.text()).toContain('Enter a host name.');
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
	});

	it('posts the host with an idempotency key and goes to the progress page', async () => {
		const wrapper = await mountPage();
		await wrapper.findAll('input[type="radio"]')[0]!.setValue(true);
		await wrapper.find('#site-name').setValue('campus-site');
		await wrapper.find('#site-host').setValue('www.example.org');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1)
		);
		const post = calls.find((call) => call.method === 'POST')!;
		expect(post.body).toEqual({ kind: 'drupal', name: 'campus-site', host: 'www.example.org' });
		expect(post.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
	});

	it('shows the refusal in words and keeps the form', async () => {
		createReply = () => ({
			status: 422,
			body: {
				code: 'unprocessable',
				message: 'That name is taken.',
				details: {},
				requestId: 'r1'
			}
		});
		const wrapper = await mountPage();
		await wrapper.findAll('input[type="radio"]')[0]!.setValue(true);
		await wrapper.find('#site-name').setValue('campus-site');
		await wrapper.find('#site-host').setValue('www.example.org');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('That name is taken.'));
		expect((wrapper.find('#site-host').element as HTMLInputElement).value).toBe(
			'www.example.org'
		);
	});

	it('offers pairing when the organization has no box', async () => {
		nodesReply = () => ({ body: { items: [], nextCursor: null } });
		const wrapper = await mountSuspended(SelfHostedPage, { route: '/new/self-hosted' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('You have no paired box yet.'));
		expect(wrapper.text()).toContain('Pair a Box');
	});

	it('shows a load failure with its request id', async () => {
		nodesReply = () => failure('internal', 'Could not read boxes', 'req_9');
		const wrapper = await mountSuspended(SelfHostedPage, { route: '/new/self-hosted' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Your Boxes'));
		expect(wrapper.text()).toContain('req_9');
	});
});
