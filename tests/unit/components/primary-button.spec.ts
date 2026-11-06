import { UButton } from '#components';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';

describe('primary solid button', () => {
	it('uses the near-black ink token for its text, not the white inverted token', async () => {
		const wrapper = await mountSuspended(UButton, {
			props: { color: 'primary', variant: 'solid' },
			slots: { default: () => 'Save' }
		});

		expect(wrapper.classes()).toContain('text-ink');
		expect(wrapper.classes()).not.toContain('text-inverted');
		expect(wrapper.classes()).toContain('bg-primary');
	});
});
