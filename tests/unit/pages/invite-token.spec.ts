import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import InvitePage from '~/pages/invite/[token].vue';
import type { InvitePreview } from '~/shared/members';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from '../stores/store-support';

const TOKEN = 'dfi_org-campus.s3cret';
const route = `/invite/${TOKEN}`;
const me = {
	id: 'usr_1',
	email: 'grace@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const preview: InvitePreview = {
	organizationName: 'Campus',
	role: 'viewer',
	expiresAt: '2026-12-01T00:00:00.000Z',
	emailMatches: true
};

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

async function mountPage(reply: Parameters<typeof registerApi>[0]) {
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [], nextCursor: null } },
		...reply
	});
	await useSessionStore().ensure();
	const wrapper = await mountSuspended(InvitePage, { route });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	vi.restoreAllMocks();
});

describe('invitation page', () => {
	it('names the organisation and the role, and sends the token in the body of the preview', async () => {
		const wrapper = await mountPage({
			'POST /api/v1/invites/preview': { body: preview }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Join Campus'));
		expect(wrapper.text()).toContain('You are invited as Viewer');
		const sent = calls.find((call) => call.path === '/api/v1/invites/preview');
		expect(sent?.body).toEqual({ token: TOKEN });
		expect(sent?.path).not.toContain(TOKEN);
	});

	it('says the invitation is for another address and does not offer to accept it', async () => {
		const wrapper = await mountPage({
			'POST /api/v1/invites/preview': { body: { ...preview, emailMatches: false } }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('sent to another address'));
		const accept = wrapper.findAll('button').find((button) => button.text().includes('Accept'));
		expect(accept?.attributes('disabled')).toBeDefined();
	});

	it('shows the error state when the link is not valid, with the request id', async () => {
		const wrapper = await mountPage({
			'POST /api/v1/invites/preview': failure(
				'not_found',
				'This invitation is not valid',
				'req_9'
			)
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('This Invitation Cannot Be Used'));
		expect(wrapper.text()).toContain('This invitation is not valid');
	});

	it('posts the token to accept and shows the refusal when accepting fails', async () => {
		const wrapper = await mountPage({
			'POST /api/v1/invites/preview': { body: preview },
			'POST /api/v1/invites/accept': failure(
				'conflict',
				'This invitation has already been used',
				'req_10'
			)
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Join Campus'));
		const accept = wrapper.findAll('button').find((button) => button.text().includes('Accept'));
		await vi.waitFor(() => expect(accept?.attributes('disabled')).toBeUndefined());
		await accept?.trigger('click');
		await vi.waitFor(() =>
			expect(calls.some((call) => call.path === '/api/v1/invites/accept')).toBe(true)
		);
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain(
				'This invitation has already been used'
			)
		);
		expect(calls.find((call) => call.path === '/api/v1/invites/accept')?.body).toEqual({
			token: TOKEN
		});
	});
});
