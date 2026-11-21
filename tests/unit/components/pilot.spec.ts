import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PilotWorkspace from '~/components/pilot/Workspace.vue';
import PilotReportSummary from '~/components/pilot/report/Summary.vue';
import type { PilotView } from '~/shared/pilots';
import { usePilotsStore, type PilotReportView } from '~/stores/pilots';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const ORG = 'org_campus';
const base = `/api/v1/orgs/${ORG}/pilots/pil_1`;
const mounted: { unmount: () => void }[] = [];
let cleanup: () => void = () => undefined;

const pilot = (over: Partial<PilotView> = {}): PilotView => ({
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
	createdAt: '2026-02-20T00:00:00.000Z',
	...over
});

const sites = [
	{ id: 'site_1', name: 'Front door' },
	{ id: 'site_2', name: 'Archive' }
];

async function mountWorkspace(props: { pilot?: PilotView; canManage?: boolean } = {}) {
	const wrapper = await mountSuspended(PilotWorkspace, {
		props: {
			orgId: ORG,
			pilot: props.pilot ?? pilot(),
			sites,
			canManage: props.canManage ?? true
		}
	});
	mounted.push(wrapper);
	return wrapper;
}

const labelled = (wrapper: VueWrapper, text: string) =>
	wrapper
		.findAll('label')
		.find((label) => label.find('span').exists() && label.find('span').text() === text)!;

const buttonNamed = (wrapper: VueWrapper, text: string) =>
	wrapper.findAll('button').find((button) => button.text() === text)!;

const buttonTexts = (wrapper: VueWrapper) =>
	wrapper.findAll('button').map((button) => button.text());

beforeEach(() => {
	clearBrowserState();
	usePilotsStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('pilot workspace', () => {
	it('saves edited success criteria through the pilot route', async () => {
		cleanup = registerApi({ [`PUT ${base}`]: { body: pilot() } });
		const wrapper = await mountWorkspace();
		await wrapper
			.find('[aria-label="Success criteria"]')
			.setValue('Cut hosting spend by half.');
		await buttonNamed(wrapper, 'Save Criteria').trigger('click');
		await vi.waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
		expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
			successCriteria: 'Cut hosting spend by half.'
		});
	});

	it('checks the sites already in the pilot and saves the new set', async () => {
		cleanup = registerApi({ [`PUT ${base}/sites`]: { body: pilot() } });
		const wrapper = await mountWorkspace();
		const front = wrapper.find('input[type="checkbox"][value="site_1"]');
		const archive = wrapper.find('input[type="checkbox"][value="site_2"]');
		expect((front.element as HTMLInputElement).checked).toBe(true);
		expect((archive.element as HTMLInputElement).checked).toBe(false);
		await archive.setValue(true);
		await buttonNamed(wrapper, 'Save Sites').trigger('click');
		await vi.waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
		expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
			siteIds: ['site_1', 'site_2']
		});
	});

	it('records an observation with its minutes and clears the form after it is saved', async () => {
		cleanup = registerApi({
			[`POST ${base}/observations`]: { status: 201, body: {} },
			[`GET ${base}/report`]: { body: {} }
		});
		const wrapper = await mountWorkspace();
		await labelled(wrapper, 'Kind').find('select').setValue('failure');
		await labelled(wrapper, 'Minutes').find('input').setValue('30');
		await labelled(wrapper, 'What Happened')
			.find('textarea')
			.setValue('Restore ran past the window');
		await wrapper.findAll('form')[0]!.trigger('submit');
		await vi.waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
			kind: 'failure',
			minutes: 30,
			text: 'Restore ran past the window'
		});
		await vi.waitFor(() =>
			expect(labelled(wrapper, 'What Happened').find('textarea').element.value).toBe('')
		);
	});

	it('records the decision with the cost to continue in cents', async () => {
		cleanup = registerApi({
			[`PUT ${base}/decision`]: { body: pilot({ decision: 'extend' }) },
			[`GET ${base}/report`]: { body: {} }
		});
		const wrapper = await mountWorkspace();
		await labelled(wrapper, 'Decision').find('select').setValue('extend');
		await labelled(wrapper, 'Cost to Continue, in Dollars').find('input').setValue('900');
		await wrapper.findAll('form')[1]!.trigger('submit');
		await vi.waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
		expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
			decision: 'extend',
			continuationCostCents: 90000
		});
	});

	it('shows the recorded decision and no editing controls once the pilot is decided', async () => {
		const wrapper = await mountWorkspace({
			pilot: pilot({ decision: 'continue', decidedAt: '2026-10-01' })
		});
		expect(wrapper.text()).toContain('Decided: continue on 2026-10-01.');
		expect(wrapper.findAll('form')).toHaveLength(0);
		expect(buttonTexts(wrapper)).not.toContain('Save Criteria');
		expect(
			wrapper.find('[aria-label="Success criteria"]').attributes('disabled')
		).toBeDefined();
	});

	it('gives a viewer the pilot read-only, with no saving or recording controls', async () => {
		const wrapper = await mountWorkspace({ canManage: false });
		expect(wrapper.findAll('form')).toHaveLength(0);
		expect(buttonTexts(wrapper)).not.toContain('Save Criteria');
		expect(buttonTexts(wrapper)).not.toContain('Save Sites');
		expect(
			wrapper.find('[aria-label="Success criteria"]').attributes('disabled')
		).toBeDefined();
		expect(
			wrapper.find('input[type="checkbox"][value="site_1"]').attributes('disabled')
		).toBeDefined();
	});
});

const report = (over: Partial<PilotReportView> = {}): PilotReportView => ({
	name: 'Shared drafts',
	startDate: '2026-03-01',
	sponsor: 'Campus IT',
	technicalOwner: null,
	decision: null,
	decidedAt: null,
	successCriteria: 'Cut hosting spend by a third.',
	hosting: { baselineSpendCents: 120000, status: 'not measured' },
	drupflare: {
		costCents: null,
		costStatus: 'not measured',
		views: 400,
		state: 'estimated',
		continuationCostCents: null
	},
	staff: { baselineHours: 40, observedMinutes: 90, observedEntries: 3 },
	baseline: { latencyMs: null, restoreMinutes: null, rollbackMinutes: null, patchDays: null },
	failures: [],
	unsupported: [],
	exceptions: [],
	sites: [],
	observations: [],
	negativeResults: 0,
	...over
});

async function mountSummary(over: Partial<PilotReportView> = {}, exportHref = '/export.csv') {
	const wrapper = await mountSuspended(PilotReportSummary, {
		props: { report: report(over), exportHref }
	});
	mounted.push(wrapper);
	return wrapper;
}

const flat = (wrapper: { text: () => string }) => wrapper.text().replace(/\s+/g, ' ');

const definition = (wrapper: VueWrapper, term: string) =>
	wrapper
		.findAll('dt')
		.find((dt) => dt.text() === term)!
		.element.nextElementSibling!.textContent!.replace(/\s+/g, ' ')
		.trim();

describe('pilot report summary', () => {
	it('titles the report and names the sponsor and start date', async () => {
		const wrapper = await mountSummary();
		expect(flat(wrapper)).toContain('Shared drafts Report');
		expect(flat(wrapper)).toContain('Started 2026-03-01, sponsor Campus IT');
	});

	it('shows the baseline spend in dollars and says nothing was measured with Drupflare', async () => {
		const wrapper = await mountSummary();
		expect(definition(wrapper, 'Before the Pilot')).toBe('$1,200.00');
		expect(definition(wrapper, 'With Drupflare')).toBe('Not Measured');
	});

	it('shows Not Set when the baseline spend was never recorded', async () => {
		const wrapper = await mountSummary({
			hosting: { baselineSpendCents: null, status: 'not measured' }
		});
		expect(definition(wrapper, 'Before the Pilot')).toBe('Not Set');
	});

	it('shows the views with their accounting state and the cost to continue', async () => {
		const wrapper = await mountSummary({
			drupflare: { ...report().drupflare, continuationCostCents: 90000 }
		});
		expect(definition(wrapper, 'Views in the Pilot')).toBe('400 (Estimated)');
		expect(definition(wrapper, 'To Continue')).toBe('$900.00');
	});

	it('compares the baseline staff hours with the observed time in hours', async () => {
		const wrapper = await mountSummary();
		expect(flat(wrapper)).toContain(
			'Before: 40 hours a month. Observed: 1.5 hours across 3 tasks.'
		);
	});

	it('shows the baseline staff hours as Not Set when none were recorded', async () => {
		const wrapper = await mountSummary({
			staff: { baselineHours: null, observedMinutes: 0, observedEntries: 0 }
		});
		expect(flat(wrapper)).toContain('Before: Not Set hours a month.');
	});

	it('lists failures and unsupported work under the negative result count', async () => {
		const wrapper = await mountSummary({
			negativeResults: 2,
			failures: [{ id: 'obs_1', at: '2026-03-04', text: 'Restore ran past the window' }],
			unsupported: [{ id: 'obs_2', at: '2026-03-05', text: 'Multi-site staging' }]
		});
		expect(flat(wrapper)).toContain('2 negative results are listed below.');
		expect(wrapper.text()).toContain('Failure: Restore ran past the window');
		expect(wrapper.text()).toContain('Unsupported: Multi-site staging');
	});

	it('shows the exceptions section only when there are exceptions', async () => {
		const none = await mountSummary();
		expect(none.text()).not.toContain('Exceptions');
		const some = await mountSummary({
			exceptions: [{ id: 'obs_3', at: '2026-03-06', text: 'Legacy search was left on' }]
		});
		expect(some.text()).toContain('Exceptions');
		expect(some.text()).toContain('Legacy search was left on');
	});

	it('says the owner has written no success criteria when the field is empty', async () => {
		const wrapper = await mountSummary({ successCriteria: '' });
		expect(wrapper.text()).toContain('The owner has not written success criteria.');
	});

	it('links the CSV download to the export address it was given', async () => {
		const wrapper = await mountSummary({}, '/api/v1/orgs/org_campus/pilots/pil_1/export');
		expect(wrapper.find('a[href="/api/v1/orgs/org_campus/pilots/pil_1/export"]').text()).toBe(
			'Download CSV'
		);
	});

	it('prints the page for Save as PDF', async () => {
		const original = window.print;
		const print = vi.fn();
		window.print = print;
		try {
			const wrapper = await mountSummary();
			await buttonNamed(wrapper, 'Save as PDF').trigger('click');
			expect(print).toHaveBeenCalledTimes(1);
		} finally {
			window.print = original;
		}
	});
});
