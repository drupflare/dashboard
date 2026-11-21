import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PilotDetailPage from '~/pages/org/pilots/[id].vue';
import PilotsPage from '~/pages/org/pilots/index.vue';
import type { CostSite } from '~/shared/cost-centers';
import type { PilotView } from '~/shared/pilots';
import { useCostCentersStore } from '~/stores/cost-centers';
import { useOrgStore } from '~/stores/org';
import { usePilotsStore, type PilotReportView } from '~/stores/pilots';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, failure, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/pilots`;
const costSites = `/api/v1/orgs/${ORG}/cost-centers/sites`;
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

const pilot: PilotView = {
	id: 'pil_1',
	name: 'Shared drafts',
	state: 'running',
	startDate: '2026-03-01',
	sponsor: null,
	technicalOwner: null,
	baselineHostingSpendCents: 120000,
	baselineStaffHours: 40,
	baselineLatencyMs: null,
	baselineRestoreMinutes: null,
	baselineRollbackMinutes: null,
	baselinePatchDays: null,
	successCriteria: 'Cut hosting spend by a third.',
	decision: null,
	decidedAt: null,
	continuationCostCents: null,
	siteIds: ['site_1'],
	createdAt: '2026-02-20T00:00:00.000Z'
};

const sites: CostSite[] = [
	{ id: 'site_1', name: 'Front door', costCenterId: null },
	{ id: 'site_2', name: 'Archive', costCenterId: null }
];

const report: PilotReportView = {
	name: 'Shared drafts',
	startDate: '2026-03-01',
	sponsor: null,
	technicalOwner: null,
	decision: null,
	decidedAt: null,
	successCriteria: 'Cut hosting spend by a third.',
	hosting: { baselineSpendCents: 120000, status: 'not measured' },
	drupflare: {
		costCents: null,
		costStatus: 'not measured',
		views: 0,
		state: 'unaccounted',
		continuationCostCents: null
	},
	staff: { baselineHours: 40, observedMinutes: 0, observedEntries: 0 },
	baseline: { latencyMs: null, restoreMinutes: null, rollbackMinutes: null, patchDays: null },
	failures: [],
	unsupported: [],
	exceptions: [],
	sites: [],
	observations: [],
	negativeResults: 0
};

let cleanup: () => void = () => undefined;
let role = 'owner';
let list: PilotView[] = [pilot];
const mounted: { unmount: () => void }[] = [];

function stubRoutes(extra: Parameters<typeof registerApi>[0] = {}) {
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': {
			body: { items: [{ id: ORG, name: 'Campus', personal: false, role }], nextCursor: null }
		},
		[`GET ${base}`]: () => ({ body: { items: list } }),
		[`GET ${base}/pil_1`]: { body: pilot },
		[`GET ${base}/pil_1/report`]: { body: report },
		[`GET ${costSites}`]: { body: { items: sites } },
		...extra
	});
}

async function mountList() {
	useOrgStore().$reset();
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(PilotsPage, { route: '/org/pilots' });
	mounted.push(wrapper);
	return wrapper;
}

async function mountDetail(route = '/org/pilots/pil_1') {
	useOrgStore().$reset();
	await useOrgStore().ensure();
	const wrapper = await mountSuspended(PilotDetailPage, { route });
	mounted.push(wrapper);
	return wrapper;
}

const fieldLabelled = (wrapper: Awaited<ReturnType<typeof mountList>>, text: string) =>
	wrapper
		.findAll('label')
		.find((label) => label.find('span').text() === text)!
		.find('input');

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	usePilotsStore().$reset();
	useCostCentersStore().$reset();
	role = 'owner';
	list = [pilot];
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('pilots list page', () => {
	it('lists each pilot with its state, start date and a link to it', async () => {
		stubRoutes();
		const wrapper = await mountList();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Shared drafts'));
		expect(wrapper.text()).toContain('running since 2026-03-01');
		expect(wrapper.find('a[href="/org/pilots/pil_1"]').exists()).toBe(true);
	});

	it('shows the empty state and the start form to an owner when there are no pilots', async () => {
		list = [];
		stubRoutes();
		const wrapper = await mountList();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No pilots yet.'));
		expect(wrapper.text()).toContain('Start a Pilot');
	});

	it('gives a viewer the list and no start form', async () => {
		role = 'viewer';
		stubRoutes();
		const wrapper = await mountList();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Shared drafts'));
		expect(wrapper.text()).not.toContain('Start a Pilot');
	});

	it('refuses the list to a role without pilot access and asks nothing of the API', async () => {
		role = 'billing';
		stubRoutes();
		const wrapper = await mountList();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Your role cannot view pilots.'));
		expect(calls.some((call) => call.path === base)).toBe(false);
	});

	it('starts a pilot with the baseline converted to cents and the empty fields left null', async () => {
		list = [];
		stubRoutes({ [`POST ${base}`]: { status: 201, body: { ...pilot, id: 'pil_9' } } });
		const wrapper = await mountList();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Start a Pilot'));
		await fieldLabelled(wrapper, 'Name').setValue('Shared drafts');
		await fieldLabelled(wrapper, 'Hosting Spend a Month, in Dollars').setValue('1200.5');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.body).toMatchObject({
			name: 'Shared drafts',
			sponsor: null,
			technicalOwner: null,
			baselineHostingSpendCents: 120050,
			baselineStaffHours: null,
			baselineLatencyMs: null
		});
	});

	it('shows the server refusal and does not leave the page when a pilot cannot be started', async () => {
		list = [];
		stubRoutes({
			[`POST ${base}`]: failure(
				'pilot.name_taken',
				'A pilot with that name already exists.',
				'req_p1'
			)
		});
		const wrapper = await mountList();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Start a Pilot'));
		await fieldLabelled(wrapper, 'Name').setValue('Shared drafts');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain(
				'A pilot with that name already exists.'
			)
		);
	});
});

describe('pilot detail page', () => {
	it('shows the pilot name, state and start date, with a way back to the list', async () => {
		stubRoutes();
		const wrapper = await mountDetail();
		await vi.waitFor(() => expect(wrapper.find('h1').text()).toBe('Shared drafts'));
		expect(wrapper.text()).toContain('running, started 2026-03-01');
		expect(wrapper.find('a[href="/org/pilots"]').exists()).toBe(true);
	});

	it('loads the workspace and the report for the pilot', async () => {
		stubRoutes();
		const wrapper = await mountDetail();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Shared drafts Report'));
		expect(wrapper.text()).toContain('Success Criteria');
		expect(wrapper.find('[aria-label="Success criteria"]').element).toBeTruthy();
		expect(wrapper.text()).toContain('Before the Pilot');
	});

	it('says the pilot does not exist when the API answers not found', async () => {
		stubRoutes({
			[`GET ${base}/pil_missing`]: {
				status: 404,
				body: {
					code: 'not_found',
					message: 'No such pilot.',
					details: {},
					requestId: 'req_404'
				}
			}
		});
		const wrapper = await mountDetail('/org/pilots/pil_missing');
		await vi.waitFor(() => expect(wrapper.text()).toContain('This pilot does not exist.'));
	});

	it('says the report could not be read when its request fails', async () => {
		stubRoutes({
			[`GET ${base}/pil_1/report`]: failure('internal', 'The report failed.', 'req_r1')
		});
		const wrapper = await mountDetail();
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain('The report could not be read.')
		);
	});

	it('loads the cost-center sites only for someone who can manage the pilot', async () => {
		role = 'viewer';
		stubRoutes();
		const wrapper = await mountDetail();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Shared drafts Report'));
		expect(calls.some((call) => call.path === costSites)).toBe(false);
		expect(wrapper.text()).not.toContain('Save Criteria');
	});

	it('loads the cost-center sites and the save controls for an owner', async () => {
		stubRoutes();
		const wrapper = await mountDetail();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Save Criteria'));
		await vi.waitFor(() => expect(calls.some((call) => call.path === costSites)).toBe(true));
		expect(wrapper.text()).toContain('Front door');
	});
});
