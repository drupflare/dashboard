import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import ChartTable from '~/components/chart/Table.vue';
import ChartUsage from '~/components/chart/Usage.vue';

describe('usage chart', () => {
	it('shows a single value as a number, not as a chart', async () => {
		const wrapper = await mountSuspended(ChartUsage, {
			props: {
				bars: [{ label: '2026-11-01', value: 1234, state: 'exact' }],
				ariaLabel: 'Views per day'
			}
		});
		expect(wrapper.find('svg').exists()).toBe(false);
		expect(wrapper.text()).toContain('1,234');
	});

	it('draws a labelled chart on a zero baseline, and outlines the bar that was not recorded', async () => {
		const wrapper = await mountSuspended(ChartUsage, {
			props: {
				bars: [
					{ label: 'Alpha', value: 10, state: 'exact' },
					{ label: 'Beta', value: 0, state: 'unaccounted' }
				],
				ariaLabel: 'Views per site, largest first',
				showValues: true
			}
		});
		const svg = wrapper.find('svg');
		expect(svg.attributes('role')).toBe('img');
		expect(svg.attributes('aria-label')).toBe('Views per site, largest first');
		expect(svg.find('line').exists()).toBe(true);
		const rects = svg.findAll('rect');
		expect(rects[0]!.attributes('stroke-dasharray')).toBeUndefined();
		expect(rects[1]!.attributes('stroke-dasharray')).toBe('4 3');
		expect(svg.text()).toContain('10');
	});
});

describe('usage table', () => {
	it('names every accounting state in words, not only by colour', async () => {
		const wrapper = await mountSuspended(ChartTable, {
			props: {
				caption: 'Views per day',
				rows: [
					{ label: '2026-11-01', views: 10, lowerBound: 10, state: 'exact' },
					{ label: '2026-11-02', views: 0, lowerBound: 0, state: 'unaccounted' }
				]
			}
		});
		expect(wrapper.find('caption').text()).toBe('Views per day');
		expect(wrapper.text()).toContain('Exact');
		expect(wrapper.text()).toContain('Not Recorded');
	});
});
