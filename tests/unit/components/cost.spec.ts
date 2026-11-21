import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import CostTree from '~/components/cost/Tree.vue';
import type { CostCenterView, CostSite } from '~/shared/cost-centers';

const mounted: { unmount: () => void }[] = [];

const center = (id: string, code: string, name: string): CostCenterView => ({
	id,
	code,
	name,
	departmentId: null,
	ownerContact: null,
	createdAt: '2026-02-01T00:00:00.000Z'
});

const centers = [center('cc_1', 'WEB', 'Web'), center('cc_2', 'ADM', 'Admissions')];

const sites: CostSite[] = [
	{ id: 'site_1', name: 'Front door', costCenterId: 'cc_1' },
	{ id: 'site_2', name: 'Archive', costCenterId: null },
	{ id: 'site_3', name: 'Press', costCenterId: 'cc_1' }
];

async function mountTree(
	props: Partial<{ centers: CostCenterView[]; sites: CostSite[]; saving: boolean }> = {}
) {
	const wrapper = await mountSuspended(CostTree, {
		props: { centers, sites, saving: false, ...props }
	});
	mounted.push(wrapper);
	return wrapper;
}

const select = (wrapper: Awaited<ReturnType<typeof mountTree>>, site: string) =>
	wrapper.find(`[aria-label="Cost center for ${site}"]`);

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
});

describe('cost center tree', () => {
	it('groups each site under the center it bills to', async () => {
		const wrapper = await mountTree();
		const web = wrapper.findAll('section').find((section) => section.text().startsWith('WEB'))!;
		expect(web.text()).toContain('Front door');
		expect(web.text()).toContain('Press');
		expect(web.text()).not.toContain('Archive');
		expect((select(wrapper, 'Front door').element as HTMLSelectElement).value).toBe('cc_1');
	});

	it('says a center with no sites yet, without listing any', async () => {
		const wrapper = await mountTree();
		const admissions = wrapper
			.findAll('section')
			.find((section) => section.text().startsWith('ADM'))!;
		expect(admissions.text()).toContain('No sites bill to this cost center yet.');
	});

	it('lists sites with no center apart, and omits that section when every site has one', async () => {
		const wrapper = await mountTree();
		expect(wrapper.text()).toContain('Sites Without a Cost Center');
		expect(select(wrapper, 'Archive').exists()).toBe(true);

		const assigned = await mountTree({
			sites: sites.filter((site) => site.costCenterId !== null)
		});
		expect(assigned.text()).not.toContain('Sites Without a Cost Center');
	});

	it('reports a move to another center with the site id and the new center', async () => {
		const wrapper = await mountTree();
		await select(wrapper, 'Front door').setValue('cc_2');
		expect(wrapper.emitted('assign')).toEqual([['site_1', 'cc_2']]);
	});

	it('reports removing a site from its center as a null center', async () => {
		const wrapper = await mountTree();
		await select(wrapper, 'Front door').setValue('');
		expect(wrapper.emitted('assign')).toEqual([['site_1', null]]);
	});

	it('reports placing a site with no center into one', async () => {
		const wrapper = await mountTree();
		await select(wrapper, 'Archive').setValue('cc_2');
		expect(wrapper.emitted('assign')).toEqual([['site_2', 'cc_2']]);
	});

	it('disables every site selector while a save is running', async () => {
		const wrapper = await mountTree({ saving: true });
		for (const name of ['Front door', 'Press', 'Archive']) {
			expect(select(wrapper, name).attributes('disabled')).toBeDefined();
		}
	});

	it('disables the selector for a site with no center when there are no centers to pick', async () => {
		const wrapper = await mountTree({ centers: [] });
		expect(select(wrapper, 'Archive').attributes('disabled')).toBeDefined();
	});
});
