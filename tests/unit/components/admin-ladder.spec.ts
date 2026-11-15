import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it } from 'vitest';
import Catalogue from '~/components/admin/ladder/Catalogue.vue';
import Switch from '~/components/admin/ladder/Switch.vue';
import type { LadderRow } from '~/stores/admin-ladder';

const mounted: { unmount: () => void }[] = [];

afterEach(() => {
	for (const wrapper of mounted.splice(0)) wrapper.unmount();
});

const row = (overrides: Partial<LadderRow> = {}): LadderRow => ({
	repairId: 'bridge.asyncify_called',
	source: 'worker host tripwire',
	severity: 'critical',
	handle: 'interpreter-recycle',
	automation: 'auto-with-guard',
	canRunToday: false,
	reason: 'No route on the site worker for this repair yet. It refuses to run.',
	...overrides
});

describe('the catalogue table', () => {
	it('shows the reason for a row that cannot run today', async () => {
		const wrapper = await mountSuspended(Catalogue, { props: { rows: [row()] } });
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('bridge.asyncify_called');
		expect(wrapper.text()).toContain('No route on the site worker for this repair yet.');
	});

	it('shows Yes for a row that can run today', async () => {
		const wrapper = await mountSuspended(Catalogue, {
			props: { rows: [row({ canRunToday: true, reason: null })] }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Yes');
	});
});

describe('the switch form', () => {
	it('does not save a global switch until the typed word matches', async () => {
		const wrapper = await mountSuspended(Switch, {
			props: { switches: [], busy: false, error: null }
		});
		mounted.push(wrapper);
		await wrapper.find('select').setValue('global');
		const save = () => wrapper.find('button[type="submit"]');
		expect(save().attributes('disabled')).toBeDefined();

		await wrapper.find('input[type="text"]').setValue('global');
		expect(save().attributes('disabled')).toBeUndefined();
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({
			scope: 'global',
			scopeId: '',
			auto: false,
			confirmation: 'global'
		});
	});

	it('saves a site switch with its id and no confirmation', async () => {
		const wrapper = await mountSuspended(Switch, {
			props: { switches: [], busy: false, error: null }
		});
		mounted.push(wrapper);
		await wrapper.find('input[type="text"]').setValue('site_1');
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('save')?.[0]?.[0]).toEqual({
			scope: 'site',
			scopeId: 'site_1',
			auto: false
		});
	});
});
