import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DbPage from '~/pages/admin/db.vue';
import SupportGrantsPage from '~/pages/admin/support-grants.vue';
import OrgSupportPage from '~/pages/org/support.vue';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const ORG = 'org_personal';
const mounted: { unmount: () => void }[] = [];
let cleanup: () => void = () => undefined;

const meOf = (role: string | null, fresh: boolean) => ({
	id: 'usr_1',
	email: 'admin@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: fresh ? new Date(Date.now() + 600_000).toISOString() : null,
	platformRole: role
});

function signIn(role: string | null = 'admin', fresh = true) {
	useSessionStore().me = meOf(role, fresh) as never;
}

const posts = () => calls.filter((c) => c.method === 'POST');

beforeEach(() => {
	clearBrowserState();
	calls.length = 0;
	useSessionStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

const grant = {
	id: 'sg_1',
	organizationId: 'org_1',
	grantedBy: 'user:owner',
	scope: 'act',
	reason: 'Help with the upgrade',
	createdAt: 1,
	expiresAt: Date.UTC(2026, 10, 25, 12, 0),
	revokedAt: null,
	live: true
};

describe('admin support access page', () => {
	const listing = (
		body: unknown = { grants: [grant], breakGlass: [] }
	): Record<string, Reply> => ({
		'GET /api/v1/admin/support-grants': { body }
	});

	it('lists the live grants with their scope and end', async () => {
		signIn();
		cleanup = registerApi(listing());
		const wrapper = await mountSuspended(SupportGrantsPage, { route: '/admin/support-grants' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Help with the upgrade'));
		expect(wrapper.text()).toContain('Act on the Organization');
		expect(wrapper.text()).toContain('2026-11-25 12:00');
	});

	it('says so when no grant is live and shows the error state when the list fails', async () => {
		signIn();
		cleanup = registerApi(listing({ grants: [], breakGlass: [] }));
		const wrapper = await mountSuspended(SupportGrantsPage, { route: '/admin/support-grants' });
		mounted.push(wrapper);
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('No organization has a live grant.')
		);
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/admin/support-grants': {
				status: 500,
				body: { code: 'internal', message: 'Down' }
			}
		});
		const failing = await mountSuspended(SupportGrantsPage, { route: '/admin/support-grants' });
		mounted.push(failing);
		await vi.waitFor(() => expect(failing.text()).toContain('Support Access Could Not Load'));
	});

	it('shows Page Not Found to a person without the admin role', async () => {
		signIn(null);
		cleanup = registerApi(listing());
		const wrapper = await mountSuspended(SupportGrantsPage, { route: '/admin/support-grants' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Page Not Found'));
	});

	it('keeps break-glass off until the reason is long enough, then posts it and shows the result', async () => {
		signIn();
		cleanup = registerApi({
			...listing(),
			'POST /api/v1/admin/break-glass': {
				status: 201,
				body: {
					id: 'sg_2',
					organizationId: 'org_1',
					admin: 'usr_1',
					reason: 'Site down and the owner is unreachable',
					startedAt: 1,
					expiresAt: Date.UTC(2026, 10, 21, 13, 0),
					ownersNotified: 2,
					live: true
				}
			}
		});
		const wrapper = await mountSuspended(SupportGrantsPage, { route: '/admin/support-grants' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Break-Glass Access'));
		const submit = () =>
			wrapper.findAll('button').find((b) => b.text() === 'Start Break-Glass Access');
		expect(submit()?.attributes('disabled')).toBeDefined();
		await wrapper.find('#glass-org').setValue('org_1');
		await wrapper.find('#glass-reason').setValue('too short');
		expect(submit()?.attributes('disabled')).toBeDefined();
		await wrapper.find('#glass-reason').setValue('Site down and the owner is unreachable');
		await wrapper.find('form[aria-labelledby="break-glass-title"]').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('2 owners emailed'));
		expect(posts()[0]?.body).toEqual({
			organizationId: 'org_1',
			reason: 'Site down and the owner is unreachable'
		});
	});

	it('asks for step-up and sends nothing when the last step-up is stale', async () => {
		signIn('admin', false);
		cleanup = registerApi(listing());
		const wrapper = await mountSuspended(SupportGrantsPage, { route: '/admin/support-grants' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Break-Glass Access'));
		await wrapper.find('#glass-org').setValue('org_1');
		await wrapper.find('#glass-reason').setValue('Site down and the owner is unreachable');
		await wrapper.find('form[aria-labelledby="break-glass-title"]').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.findComponent({ name: 'AccountStepUp' }).exists()).toBe(true)
		);
		expect(posts()).toEqual([]);
	});
});

describe('admin database console page', () => {
	const aside: Record<string, Reply> = {
		'GET /api/v1/admin/db/shards': { body: { shards: [{ shard: 'DB', sizeBytes: 10 }] } },
		'GET /api/v1/admin/db/queries': { body: { items: [] } }
	};

	it('runs a statement and shows the rows and the truncation note', async () => {
		signIn();
		cleanup = registerApi({
			...aside,
			'POST /api/v1/admin/db/query': {
				body: {
					results: [
						{
							shard: 'directory',
							columns: ['id', 'key_hash'],
							rows: [{ id: 'a', key_hash: '[masked]' }],
							truncated: true,
							explain: false
						}
					]
				}
			}
		});
		const wrapper = await mountSuspended(DbPage, { route: '/admin/db' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Saved Queries'));
		await wrapper.find('form[aria-labelledby="query-title"]').trigger('submit');
		await vi.waitFor(() => expect(wrapper.text()).toContain('[masked]'));
		expect(wrapper.text()).toContain('Showing the first 200 rows.');
		expect(posts()[0]?.body).toMatchObject({ shard: 'directory', explain: false });
	});

	it('shows the refusal text when the statement is not allowed', async () => {
		signIn();
		cleanup = registerApi({
			...aside,
			'POST /api/v1/admin/db/query': {
				status: 422,
				body: { code: 'unprocessable', message: 'Only a SELECT statement is allowed' }
			}
		});
		const wrapper = await mountSuspended(DbPage, { route: '/admin/db' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Saved Queries'));
		await wrapper.find('form[aria-labelledby="query-title"]').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Only a SELECT statement is allowed')
		);
	});

	it('shows Page Not Found to a person without the admin role', async () => {
		signIn(null);
		cleanup = registerApi(aside);
		const wrapper = await mountSuspended(DbPage, { route: '/admin/db' });
		mounted.push(wrapper);
		await vi.waitFor(() => expect(wrapper.text()).toContain('Page Not Found'));
	});
});

describe('organization support access page', () => {
	const key = `/api/v1/orgs/${ORG}/support-grants`;

	async function mountOrg(extra: Record<string, Reply> = {}, items: unknown[] = [grant]) {
		useOrgStore().$reset();
		cleanup = registerApi({
			'GET /api/v1/me': { body: meOf(null, true) },
			'GET /api/v1/me/organizations': {
				body: {
					items: [{ id: ORG, name: 'Personal', personal: true, role: 'owner' }],
					nextCursor: null
				}
			},
			[`GET ${key}`]: { body: { items } },
			...extra
		});
		await useOrgStore().ensure();
		const wrapper = await mountSuspended(OrgSupportPage, { route: '/org/support' });
		mounted.push(wrapper);
		return wrapper;
	}

	it('lists grants with their end and a revoke button for a live one', async () => {
		signIn(null);
		const wrapper = await mountOrg({ [`DELETE ${key}/sg_1`]: { status: 204, body: null } });
		await vi.waitFor(() => expect(wrapper.text()).toContain('Help with the upgrade'));
		const revoke = wrapper.findAll('button').find((b) => b.text() === 'Revoke');
		await revoke?.trigger('click');
		await vi.waitFor(() =>
			expect(calls.some((c) => c.method === 'DELETE' && c.path === `${key}/sg_1`)).toBe(true)
		);
	});

	it('says when support was never let in, and marks a revoked grant', async () => {
		signIn(null);
		const empty = await mountOrg({}, []);
		await vi.waitFor(() =>
			expect(empty.text()).toContain('You have not given support access.')
		);
		const revoked = await mountOrg({}, [{ ...grant, live: false, revokedAt: 5 }]);
		await vi.waitFor(() => expect(revoked.text()).toContain('Revoked'));
		expect(revoked.findAll('button').some((b) => b.text() === 'Revoke')).toBe(false);
	});

	it('posts a grant with its scope, hours and reason', async () => {
		signIn(null);
		const wrapper = await mountOrg({ [`POST ${key}`]: { status: 201, body: grant } });
		await vi.waitFor(() => expect(wrapper.text()).toContain('Grant Access'));
		await wrapper.find('#support-hours').setValue('12');
		await wrapper.find('#support-reason').setValue('Help with the upgrade');
		await wrapper.find('form[aria-labelledby="grant-support-title"]').trigger('submit');
		await vi.waitFor(() => expect(posts()).toHaveLength(1));
		expect(posts()[0]?.body).toEqual({
			scope: 'read-metadata',
			hours: 12,
			reason: 'Help with the upgrade'
		});
	});

	it('shows the error state when the list does not load', async () => {
		signIn(null);
		const wrapper = await mountOrg({
			[`GET ${key}`]: { status: 500, body: { code: 'internal', message: 'Down' } }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Support Access Could Not Load'));
	});
});
