import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import EmptyState from '~/components/ui/EmptyState.vue';

describe('UiEmptyState', () => {
	it('shows the title and the sentence under it', async () => {
		const wrapper = await mountSuspended(EmptyState, {
			props: {
				icon: 'i-lucide-archive',
				title: 'No Backups Yet',
				text: 'Back up the site first.'
			}
		});

		expect(wrapper.text()).toContain('No Backups Yet');
		expect(wrapper.text()).toContain('Back up the site first.');
	});

	it('has no dashed box and centers nothing', async () => {
		const wrapper = await mountSuspended(EmptyState, {
			props: { icon: 'i-lucide-archive', title: 'No Backups Yet' }
		});

		expect(wrapper.html()).not.toContain('border-dashed');
		expect(wrapper.html()).not.toContain('text-center');
	});

	it('renders its actions only when it is given some', async () => {
		const bare = await mountSuspended(EmptyState, {
			props: { icon: 'i-lucide-archive', title: 'None' }
		});
		const withAction = await mountSuspended(EmptyState, {
			props: { icon: 'i-lucide-archive', title: 'None' },
			slots: { default: '<button>Try Again</button>' }
		});

		expect(bare.find('button').exists()).toBe(false);
		expect(withAction.find('button').text()).toBe('Try Again');
	});
});
