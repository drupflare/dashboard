import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReviewPage from '~/pages/org/reviews/[id].vue';
import ReviewsPage from '~/pages/org/reviews/index.vue';
import ServiceAccountsPage from '~/pages/org/service-accounts.vue';
import type { ReviewDetail, ReviewItemView, ReviewView } from '~/shared/access-reviews';
import type { ServiceAccountView } from '~/shared/service-accounts';
import { useAccessReviewsStore } from '~/stores/access-reviews';
import { useDepartmentsStore } from '~/stores/departments';
import { useMembersStore } from '~/stores/members';
import { useOrgStore } from '~/stores/org';
import { useServiceAccountsStore } from '~/stores/service-accounts';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const ORG = 'org_personal';
const base = `/api/v1/orgs/${ORG}`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const account = (over: Partial<ServiceAccountView> = {}): ServiceAccountView => ({
	id: 'sa_1',
	name: 'Deploy Bot',
	departmentId: null,
	ownerUserId: 'usr_2',
	ownerEmail: 'dev@example.test',
	state: 'active',
	expiresAt: '2027-01-01T00:00:00.000Z',
	disabledAt: null,
	createdAt: '2026-11-01T00:00:00.000Z',
	keyCount: 2,
	lastUsedAt: null,
	...over
});

const review = (over: Partial<ReviewView> = {}): ReviewView => ({
	id: 'rv_1',
	scope: 'organization',
	scopeName: 'The whole organization',
	state: 'open',
	dueAt: '2026-12-21T00:00:00.000Z',
	createdBy: 'user:usr_1',
	createdAt: '2026-11-21T00:00:00.000Z',
	closedAt: null,
	total: 3,
	pending: 2,
	keep: 1,
	revoke: 0,
	...over
});

const item = (over: Partial<ReviewItemView> = {}): ReviewItemView => ({
	kind: 'api-key',
	subjectRef: 'k1',
	label: 'ci runner',
	detail: 'Made by dev@example.test',
	heldBy: 'dev@example.test',
	decision: 'pending',
	decidedBy: null,
	decidedAt: null,
	reason: null,
	appliedAt: null,
	applyError: null,
	own: false,
	...over
});

let cleanup: () => void = () => undefined;
let role = 'owner';
let accounts: Reply | (() => Reply) = { body: { items: [] } };
let reviews: Reply = { body: { items: [] } };
let detail: Reply | (() => Reply) = { body: null };
let stale: Reply = { body: { days: 90, items: [] } };
let schedule: Reply = { body: { interval: 'off', lastOpenedAt: null } };
let settings: Reply = { body: { departmentAdminsDecideReviews: true } };
let departmentList: Reply = { body: { items: [], central: true } };
const mounted: { unmount: () => void }[] = [];

async function mount(component: object, route: string, extra: Record<string, unknown> = {}) {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Personal', personal: true, role }], nextCursor: null }
		},
		[`GET ${base}/service-accounts`]: () =>
			typeof accounts === 'function' ? accounts() : accounts,
		[`GET ${base}/service-accounts/sa_1/keys`]: {
			body: {
				items: [
					{
						id: 'k1',
						name: 'ci',
						prefix: 'dfk_abc',
						scopes: [],
						createdAt: '2026-11-01T00:00:00.000Z',
						lastUsedAt: null,
						expiresAt: '2027-01-01T00:00:00.000Z',
						revokedAt: null
					}
				]
			}
		},
		[`GET ${base}/members`]: { body: { items: [], nextCursor: null } },
		[`GET ${base}/departments`]: () => departmentList,
		[`GET ${base}/settings`]: () => settings,
		[`GET ${base}/reviews`]: () => reviews,
		[`GET ${base}/reviews/schedule`]: () => schedule,
		[`GET ${base}/reviews/stale`]: () => stale,
		[`GET ${base}/reviews/rv_1`]: () => (typeof detail === 'function' ? detail() : detail),
		...extra
	} as never);
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(component, { route });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useServiceAccountsStore().$reset();
	useAccessReviewsStore().$reset();
	useMembersStore().$reset();
	useDepartmentsStore().$reset();
	role = 'owner';
	accounts = { body: { items: [] } };
	reviews = { body: { items: [] } };
	detail = { body: null };
	stale = { body: { days: 90, items: [] } };
	schedule = { body: { interval: 'off', lastOpenedAt: null } };
	settings = { body: { departmentAdminsDecideReviews: true } };
	departmentList = { body: { items: [], central: true } };
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('service accounts page', () => {
	it('shows the empty state with a create button for an owner', async () => {
		const wrapper = await mount(ServiceAccountsPage, '/org/service-accounts');
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Service Accounts Yet'));
		expect(wrapper.findAll('button').some((b) => b.text() === 'Create a Service Account')).toBe(
			true
		);
	});

	it('tells a viewer that only owners and admins manage them, and loads nothing', async () => {
		role = 'viewer';
		const wrapper = await mount(ServiceAccountsPage, '/org/service-accounts');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Owners and Admins Only'));
		expect(calls.some((c) => c.path.endsWith('/service-accounts'))).toBe(false);
	});

	it('lists each account with its owner, state and expiry, and opens its keys', async () => {
		accounts = {
			body: { items: [account(), account({ id: 'sa_2', name: 'Old', state: 'expired' })] }
		};
		const wrapper = await mount(ServiceAccountsPage, '/org/service-accounts');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Deploy Bot'));
		expect(wrapper.text()).toContain('dev@example.test');
		expect(wrapper.text()).toContain('Expired');
		await wrapper
			.findAll('button')
			.find((b) => b.attributes('aria-label') === 'Keys for Deploy Bot')!
			.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.find('ul[aria-label="Keys"]').text()).toContain('ci')
		);
	});

	it('offers no new key and no disable for a disabled account', async () => {
		accounts = { body: { items: [account({ state: 'disabled' })] } };
		const wrapper = await mount(ServiceAccountsPage, '/org/service-accounts');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Disabled'));
		const labels = wrapper.findAll('button').map((b) => b.attributes('aria-label'));
		expect(labels).not.toContain('Disable Deploy Bot');
		expect(labels).not.toContain('New key for Deploy Bot');
	});

	it('shows an error with a retry', async () => {
		let healthy = false;
		accounts = () =>
			healthy ? { body: { items: [account()] } } : failure('internal', 'It is down', 'req_5');
		const wrapper = await mount(ServiceAccountsPage, '/org/service-accounts');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Service Accounts'));
		healthy = true;
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Try Again')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Deploy Bot'));
	});
});

describe('reviews page', () => {
	it('shows the empty state and an open button for an owner', async () => {
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Reviews Yet'));
		expect(wrapper.findAll('button').some((b) => b.text() === 'Open a Review')).toBe(true);
	});

	it('lists reviews with progress and a link, and shows the schedule', async () => {
		reviews = {
			body: { items: [review(), review({ id: 'rv_2', state: 'closed', pending: 0 })] }
		};
		schedule = { body: { interval: 'quarterly', lastOpenedAt: null } };
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The whole organization'));
		expect(wrapper.text()).toContain('1 of 3');
		expect(wrapper.text()).toContain('3 of 3');
		const links = wrapper.findAll('a').map((a) => a.attributes('href'));
		expect(links).toContain('/org/reviews/rv_1');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Every Quarter'));
	});

	it('checks for unused credentials on request and says when none are unused', async () => {
		reviews = { body: { items: [review()] } };
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Unused Credentials'));
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Check Now')!
			.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Nothing has gone unused for 90 days.')
		);
	});

	it('lists what has gone unused, with not recorded for a grant', async () => {
		reviews = { body: { items: [review()] } };
		stale = {
			body: {
				days: 90,
				items: [
					{
						kind: 'grant',
						subjectRef: 'g1',
						label: 'a@x.test on Main',
						lastUsedAt: null,
						since: '2026-01-01T00:00:00.000Z',
						days: 200
					}
				]
			}
		};
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Unused Credentials'));
		await wrapper
			.findAll('button')
			.find((b) => b.text() === 'Check Now')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('a@x.test on Main'));
		expect(wrapper.text()).toContain('Not recorded');
	});

	it('sends the new schedule when an owner changes it', async () => {
		reviews = { body: { items: [review()] } };
		const wrapper = await mount(ReviewsPage, '/org/reviews', {
			[`PUT ${base}/reviews/schedule`]: { body: { interval: 'yearly', lastOpenedAt: null } }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Repeat Automatically'));
		const store = useAccessReviewsStore();
		await store.setSchedule(ORG, 'yearly');
		expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ interval: 'yearly' });
		expect(store.schedules.get(ORG)?.data?.interval).toBe('yearly');
	});
});

const departmentAdminOf = (): Reply => ({
	body: {
		items: [{ id: 'd1', name: 'Library', canManage: true }],
		central: false
	}
});

describe('reviews page settings and department admins', () => {
	it('shows an owner the toggle, on by default, with what turning it off does', async () => {
		reviews = { body: { items: [review()] } };
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Who Can Decide'));
		const box = wrapper.find('input[type="checkbox"]');
		expect((box.element as HTMLInputElement).checked).toBe(true);
		expect(wrapper.text()).toContain('Department admins can decide review items');
		expect(wrapper.text()).toContain('keeps every decision already made');
	});

	it('sends the new value when the toggle changes', async () => {
		reviews = { body: { items: [review()] } };
		const wrapper = await mount(ReviewsPage, '/org/reviews', {
			[`PUT ${base}/settings`]: { body: { departmentAdminsDecideReviews: false } }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('Who Can Decide'));
		await wrapper.find('input[type="checkbox"]').setValue(false);
		await vi.waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
		expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
			departmentAdminsDecideReviews: false
		});
	});

	it('shows no toggle to a viewer', async () => {
		role = 'viewer';
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Owners and Admins Only'));
		// let the page's own requests land before the next test resets the stores
		await vi.waitFor(() =>
			expect(useAccessReviewsStore().settings.get(ORG)?.status).toBe('ready')
		);
		await vi.waitFor(() =>
			expect(useDepartmentsStore().departments.get(ORG)?.status).toBe('ready')
		);
		expect(wrapper.text()).not.toContain('Who Can Decide');
	});

	it('lets a department admin see the list, without the toggle, schedule or unused credentials', async () => {
		role = 'viewer';
		departmentList = departmentAdminOf();
		reviews = { body: { items: [review()] } };
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The whole organization'), {
			timeout: 4000
		});
		expect(wrapper.text()).not.toContain('Who Can Decide');
		expect(wrapper.text()).not.toContain('Repeat Automatically');
		expect(wrapper.text()).not.toContain('Unused Credentials');
		expect(calls.some((c) => c.path.endsWith('/reviews/schedule'))).toBe(false);
	});

	it('tells a department admin when the setting is off', async () => {
		role = 'viewer';
		departmentList = departmentAdminOf();
		settings = { body: { departmentAdminsDecideReviews: false } };
		const wrapper = await mount(ReviewsPage, '/org/reviews');
		await vi.waitFor(
			() => expect(wrapper.text()).toContain('Department admins cannot decide review items'),
			{ timeout: 4000 }
		);
		expect(calls.some((c) => c.path === `${base}/reviews`)).toBe(false);
	});
});

describe('review page', () => {
	it('shows a department admin the decision buttons on a limited review', async () => {
		role = 'viewer';
		departmentList = departmentAdminOf();
		detail = { body: { ...review(), limited: true, items: [item()] } };
		const wrapper = await mount(ReviewPage, '/org/reviews/rv_1');
		await vi.waitFor(() => expect(wrapper.text()).toContain('ci runner'));
		expect(wrapper.text()).toContain('You see the items in your own departments');
		const labels = wrapper.findAll('button').map((b) => b.attributes('aria-label'));
		expect(labels).toContain('Keep ci runner');
		expect(wrapper.text()).not.toContain('Apply Now');
		expect(wrapper.findAll('button').some((b) => b.text() === 'Close Review')).toBe(false);
	});

	const open = (over: Partial<ReviewDetail> = {}) => {
		detail = {
			body: {
				...review(),
				limited: false,
				items: [
					item(),
					item({
						kind: 'member',
						subjectRef: 'm1',
						label: 'owner@example.test',
						own: true
					})
				],
				...over
			}
		};
	};

	it('shows keep and remove for an item and a note instead for one about the viewer', async () => {
		open();
		const wrapper = await mount(ReviewPage, '/org/reviews/rv_1');
		await vi.waitFor(() => expect(wrapper.text()).toContain('ci runner'));
		const labels = wrapper.findAll('button').map((b) => b.attributes('aria-label'));
		expect(labels).toContain('Keep ci runner');
		expect(labels).toContain('Remove ci runner');
		expect(labels).not.toContain('Keep owner@example.test');
		expect(wrapper.text()).toContain('This one is about you. Someone else decides it.');
	});

	it('sends a decision with the reason and apply-now when ticked', async () => {
		open();
		const wrapper = await mount(ReviewPage, '/org/reviews/rv_1', {
			[`POST ${base}/reviews/rv_1/decisions`]: { body: item({ decision: 'revoke' }) }
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('ci runner'));
		await wrapper.find('input[type="checkbox"]').setValue(true);
		await wrapper.find('input[aria-label="Reason for ci runner"]').setValue('Not used');
		await wrapper
			.findAll('button')
			.find((b) => b.attributes('aria-label') === 'Remove ci runner')!
			.trigger('click');
		await vi.waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
		expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
			kind: 'api-key',
			subjectRef: 'k1',
			decision: 'revoke',
			reason: 'Not used',
			applyNow: true
		});
	});

	it('shows why a removal did not happen', async () => {
		open({
			items: [
				item({ decision: 'revoke', applyError: 'An organization needs at least one owner' })
			]
		});
		const wrapper = await mount(ReviewPage, '/org/reviews/rv_1');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain(
				'Not removed: An organization needs at least one owner'
			)
		);
	});

	it('shows the evidence hash and both downloads once the review is closed', async () => {
		open({ state: 'closed', closedAt: '2026-11-22T00:00:00.000Z', pending: 0 });
		const wrapper = await mount(ReviewPage, '/org/reviews/rv_1', {
			[`GET ${base}/reviews/rv_1/evidence`]: {
				body: { review: review({ state: 'closed' }), items: [], sha256: 'abc123def456' }
			}
		});
		await vi.waitFor(() => expect(wrapper.text()).toContain('abc123def456'));
		const links = wrapper.findAll('a').map((a) => a.attributes('href'));
		expect(links).toContain(`${base}/reviews/rv_1/evidence?format=csv`);
		expect(links).toContain(`${base}/reviews/rv_1/evidence`);
		expect(wrapper.findAll('button').some((b) => b.text() === 'Close Review')).toBe(false);
	});

	it('says the review is not found when the server does', async () => {
		detail = { status: 404, body: failure('not_found', 'Not found', 'req_4').body };
		const wrapper = await mount(ReviewPage, '/org/reviews/rv_1');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Review Not Found'));
	});
});
