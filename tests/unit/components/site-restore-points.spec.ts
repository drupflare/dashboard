import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import Points from '~/components/site/backup/Points.vue';
import { RESTORE_LAYER_FACTS, type RestorePoint } from '~/shared/restore-points';

function point(overrides: Partial<RestorePoint> = {}): RestorePoint {
	return {
		id: 'bkp-1',
		layer: 'export',
		createdAt: '2026-11-01T10:00:00.000Z',
		label: null,
		verified: false,
		moves: [...RESTORE_LAYER_FACTS.export.moves],
		doesNotMove: [...RESTORE_LAYER_FACTS.export.doesNotMove],
		...overrides
	};
}

const pitrLayer = {
	layer: 'pitr' as const,
	windowDays: 30,
	moves: [...RESTORE_LAYER_FACTS.pitr.moves],
	doesNotMove: [...RESTORE_LAYER_FACTS.pitr.doesNotMove]
};

describe('restore points table', () => {
	it('shows what each copy restores and what it does not', async () => {
		const wrapper = await mountSuspended(Points, {
			props: { points: [point()], layers: [] }
		});
		const text = wrapper.text();
		for (const item of RESTORE_LAYER_FACTS.export.moves) expect(text).toContain(item);
		for (const item of RESTORE_LAYER_FACTS.export.doesNotMove) expect(text).toContain(item);
		expect(text).toContain('Saved Copy');
	});

	it('marks a verified copy and a copy that is not yet verified, with text as well as an icon', async () => {
		const wrapper = await mountSuspended(Points, {
			props: {
				points: [
					point({ id: 'bkp-a', verified: true }),
					point({ id: 'bkp-b', verified: false })
				],
				layers: []
			}
		});
		expect(wrapper.text()).toContain('Verified');
		expect(wrapper.text()).toContain('Not Yet Verified');
		expect(wrapper.html()).toContain('i-lucide:circle-check');
		expect(wrapper.html()).toContain('i-lucide:clock');
	});

	it('lists point-in-time recovery once with its window and no per-moment rows', async () => {
		const wrapper = await mountSuspended(Points, {
			props: { points: [], layers: [pitrLayer] }
		});
		const rows = wrapper.findAll('tbody tr');
		expect(rows).toHaveLength(1);
		expect(wrapper.text()).toContain('Point in Time');
		expect(wrapper.text()).toContain('Last 30 days');
		for (const item of RESTORE_LAYER_FACTS.pitr.doesNotMove)
			expect(wrapper.text()).toContain(item);
	});

	it('states that a copy counts as verified only after a test restore passes', async () => {
		const wrapper = await mountSuspended(Points, { props: { points: [], layers: [] } });
		expect(wrapper.text()).toContain(
			'A copy counts as verified only after a test restore passes.'
		);
	});

	it('describes the point-in-time layer in the words the worker documents', async () => {
		const wrapper = await mountSuspended(Points, {
			props: { points: [], layers: [pitrLayer] }
		});
		expect(wrapper.text()).toContain(
			'Everything in the site database and its stored key-value pairs'
		);
		expect(wrapper.text()).not.toContain('secrets included');
	});
});
