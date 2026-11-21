import { mountSuspended } from '@nuxt/test-utils/runtime';
import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CostCentersPage from '~/pages/org/cost-centers.vue';
import type { CostCenterView, CostReport, CostSite } from '~/shared/cost-centers';
import { useCostCentersStore } from '~/stores/cost-centers';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/cost-centers`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const centers: CostCenterView[] = [
	{
		id: 'cc_1',
		code: 'WEB',
		name: 'Web',
		departmentId: null,
		ownerContact: null,
		createdAt: '2026-02-01T00:00:00.000Z'
	},
	{
		id: 'cc_2',
		code: 'ADM',
		name: 'Admissions',
		departmentId: null,
		ownerContact: 'ops@example.test',
		createdAt: '2026-02-02T00:00:00.000Z'
	}
];

const sites: CostSite[] = [
	{ id: 'site_1', name: 'Front door', costCenterId: 'cc_1' },
	{ id: 'site_2', name: 'Archive', costCenterId: null }
];

const unaccountedRow = {
	costCenterId: 'cc_1',
	code: 'WEB',
	name: 'Web',
	siteCount: 1,
	views: 0,
	state: 'unaccounted',
	allocatedCents: null,
	share: null,
	projectedViews: null
} as const;

const report: CostReport = {
	month: '2026-11',
	method: 'straight-line',
	amountCents: null,
	rows: [unaccountedRow],
	central: {
		costCenters: 2,
		sites: 2,
		unassignedSites: 1,
		views: 0,
		state: 'unaccounted'
	}
};

const withAmount: CostReport = {
	...report,
	amountCents: 120000,
	rows: [
		{
			...unaccountedRow,
			views: 400,
			state: 'exact',
			allocatedCents: 120000,
			share: 1,
			projectedViews: 800
		}
	],
	central: { ...report.central, views: 400, state: 'exact' }
};

let cleanup: () => void = () => undefined;
let role = 'owner';
let centerItems: CostCenterView[] = centers;
const mounted: { unmount: () => void }[] = [];

function stubRoutes(extra: Parameters<typeof registerApi>[0] = {}) {
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Campus', personal: false, role }], nextCursor: null }
		},
		[`GET ${base}`]: () => ({ body: { items: centerItems } }),
		[`GET ${base}/sites`]: { body: { items: sites } },
		[`GET ${base}/report`]: (call) => ({
			body: call.query.amountCents ? withAmount : report
		}),
		...extra
	});
}

async function mountPage() {
	useOrgStore().$reset();
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(CostCentersPage, { route: '/org/cost-centers' });
	mounted.push(wrapper);
	return wrapper;
}

const fieldLabelled = (wrapper: Awaited<ReturnType<typeof mountPage>>, text: string) =>
	wrapper
		.findAll('label')
		.find((label) => label.find('span').text() === text)!
		.find('input');

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useCostCentersStore().$reset();
	role = 'owner';
	centerItems = centers;
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('cost centers page', () => {
	it('lists each center with its sites, and the sites with no center apart', async () => {
		stubRoutes();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Admissions'));
		expect(wrapper.find('[aria-label="Cost center for Front door"]').element).toBeTruthy();
		expect(wrapper.text()).toContain('Sites Without a Cost Center');
		expect(wrapper.find('[aria-label="Cost center for Archive"]').exists()).toBe(true);
	});

	it('shows the empty state with the add form when there are no centers', async () => {
		centerItems = [];
		stubRoutes();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain(
				'No cost centers yet. Add one to start grouping sites.'
			)
		);
		expect(wrapper.text()).toContain('Add a Cost Center');
	});

	it('refuses the page to a role without cost-center access and asks nothing of the API', async () => {
		role = 'developer';
		stubRoutes();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Your role cannot view cost centers.')
		);
		expect(calls.some((call) => call.path === base)).toBe(false);
	});

	it('shows the report as unaccounted until an organisation total is entered', async () => {
		stubRoutes();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Straight-Line Projection'));
		const row = wrapper.findAll('tbody tr')[0]!;
		expect(row.text()).toContain('WEB Web');
		expect(row.text()).toContain('Unaccounted');
		expect(row.text()).toContain('Enter a Total');
		expect(row.text()).toContain('None Yet');
		expect(row.text()).toContain('Not Enough Data');
		expect(wrapper.text()).toContain('Unaccounted hours show no views.');
		expect(wrapper.text()).toContain('It is not a forecast.');
		expect(wrapper.text()).toContain('2 cost centers, 2 sites, 1 without a cost center.');
	});

	it('reads the report again with the total in cents and shows the allocation', async () => {
		stubRoutes();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Straight-Line Projection'));
		await fieldLabelled(wrapper, 'Organisation Total, in Dollars').setValue('1200');
		await vi.waitFor(() => expect(wrapper.text()).toContain('$1200.00'));
		const amountQueries = calls
			.filter((call) => call.path === `${base}/report`)
			.map((call) => call.query.amountCents);
		expect(amountQueries).toContain('120000');
		expect(wrapper.text()).toContain('800');
		expect(wrapper.find('a[href*="/cost-centers/export"]').attributes('href')).toContain(
			'amountCents=120000'
		);
	});

	it('says the report could not be read when its request fails', async () => {
		stubRoutes({
			[`GET ${base}/report`]: failure('internal', 'The report failed.', 'req_report_1')
		});
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('The report could not be read.')
		);
	});

	it('creates a center with no owner contact when that field is empty, then clears the form', async () => {
		stubRoutes({ [`POST ${base}`]: { status: 201, body: { id: 'cc_3' } } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Add a Cost Center'));
		await fieldLabelled(wrapper, 'Code').setValue('LIB');
		await fieldLabelled(wrapper, 'Name').setValue('Library');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(fieldLabelled(wrapper, 'Code').element.value).toBe(''));
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.body).toEqual({ code: 'LIB', name: 'Library', ownerContact: null });
	});

	it('shows the server refusal when a center cannot be created', async () => {
		stubRoutes({
			[`POST ${base}`]: failure(
				'cost-center.code_taken',
				'That code is already in use.',
				'req_cc_1'
			)
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Add a Cost Center'));
		await fieldLabelled(wrapper, 'Code').setValue('WEB');
		await fieldLabelled(wrapper, 'Name').setValue('Web');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('That code is already in use.')
		);
		expect(fieldLabelled(wrapper, 'Code').element.value).toBe('WEB');
	});

	it('moves a site to another center through its site route', async () => {
		stubRoutes({ [`PUT ${base}/sites/site_2`]: { body: {} } });
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.find('[aria-label="Cost center for Archive"]').exists()).toBe(true)
		);
		await wrapper.find('[aria-label="Cost center for Archive"]').setValue('cc_2');
		await vi.waitFor(() =>
			expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
				costCenterId: 'cc_2'
			})
		);
		expect(calls.find((call) => call.method === 'PUT')?.path).toBe(`${base}/sites/site_2`);
		await flushPromises();
	});
});
