import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import SiteStatus from '~/components/site/Status.vue';

const cases = [
	['active', 'Active', 'circle-check'],
	['suspended', 'Suspended', 'circle-pause'],
	['tombstoned', 'Removed', 'archive'],
	['purge-eligible', 'Scheduled for Removal', 'clock'],
	['deleted', 'Deleted', 'circle-x']
] as const;

describe('site status', () => {
	it.each(cases)('shows %s as an icon and the text %s', async (state, label, icon) => {
		const wrapper = await mountSuspended(SiteStatus, { props: { state } });

		expect(wrapper.text()).toBe(label);
		expect(wrapper.html()).toContain(icon);
	});
});
