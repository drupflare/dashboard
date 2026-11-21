import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UsagePage from '~/pages/org/usage.vue';
import type { OrgUsage, SiteMonthUsage } from '~/shared/usage';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const alphaMonth: SiteMonthUsage = {
	siteId: 'site_alpha',
	views: 900000,
	lowerBound: 850000,
	state: 'estimated',
	closed: false,
	expectedHours: 720,
	presentHours: 600,
	days: [{ day: '2026-11-01', views: 300, lowerBound: 290, state: 'exact', unaccountedHours: 0 }]
};

const orgUsage: OrgUsage = {
	month: '2026-11',
	allowance: { views: 3000000, pooled: true },
	total: {
		views: 1200000,
		lowerBound: 1100000,
		state: 'estimated',
		closed: false,
		expectedHours: 720,
		presentHours: 600
	},
	days: [
		{ day: '2026-11-01', views: 500, lowerBound: 480, state: 'exact', unaccountedHours: 0 },
		{ day: '2026-11-02', views: 0, lowerBound: 0, state: 'unaccounted', unaccountedHours: 24 }
	],
	sites: [
		{ ...alphaMonth, name: 'Alpha' },
		{
			siteId: 'site_beta',
			name: 'Beta',
			views: 300000,
			lowerBound: 250000,
			state: 'estimated',
			closed: false,
			expectedHours: 720,
			presentHours: 600,
			days: []
		}
	]
};

let cleanup: () => void = () => undefined;
let role = 'owner';
let usageReply: Reply = { body: orgUsage };
const mounted: VueWrapper[] = [];

async function mountPage() {
	useOrgStore().$reset();
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Campus', personal: false, role }], nextCursor: null }
		},
		[`GET ${base}/usage`]: () => usageReply,
		[`GET ${base}/sites/site_alpha/usage`]: { body: alphaMonth }
	});
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(UsagePage, { route: '/org/usage' });
	mounted.push(wrapper);
	return wrapper;
}

const usageCalls = () => calls.filter((call) => call.path === `${base}/usage`);

beforeEach(() => {
	clearBrowserState();
	calls.splice(0);
	useSessionStore().$reset();
	useOrgStore().$reset();
	role = 'owner';
	usageReply = { body: orgUsage };
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper: VueWrapper) => wrapper.unmount());
	cleanup();
});

describe('organisation usage page', () => {
	it('shows the organisation total, its lower bound and the pooled allowance', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('1,200,000 views'));
		expect(wrapper.text()).toContain('The lower bound is 1,100,000.');
		expect(wrapper.text()).toContain(
			'Your plan allows 3,000,000 views a month, shared across your sites.'
		);
		expect(wrapper.text()).toContain('Views are counted when the response completes.');
	});

	it('names each day state in words', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Not Recorded'));
		expect(wrapper.text()).toContain('Exact');
	});

	it('lists every site, and narrowing to one site asks for that site only', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Views per site'));
		expect(wrapper.text()).toContain('Beta');
		await wrapper.find('select').setValue('site_alpha');
		await vi.waitFor(() => expect(wrapper.text()).toContain('900,000 views'));
		expect(calls.some((call) => call.path === `${base}/sites/site_alpha/usage`)).toBe(true);
		expect(calls.some((call) => call.path === `${base}/sites/site_beta/usage`)).toBe(false);
		expect(wrapper.text()).not.toContain('Views per site');
	});

	it('says so when the role cannot read usage, and requests none', async () => {
		role = 'viewer';
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your role cannot view usage.'));
		expect(usageCalls()).toHaveLength(0);
	});

	it('says usage could not be loaded when the server fails', async () => {
		usageReply = failure('internal', 'boom', 'req_usage');
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Usage could not be loaded. Try again in a moment.')
		);
	});
});
