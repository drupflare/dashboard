import { createError } from '#app';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import ErrorPage from '~/error.vue';

describe('error page', () => {
	it('says the page does not exist, with a link home, for a 404', async () => {
		const wrapper = await mountSuspended(ErrorPage, {
			props: { error: createError({ statusCode: 404, message: 'Page not found' }) }
		});
		expect(wrapper.text()).toContain('Page Not Found');
		expect(wrapper.text()).toContain("That page doesn't exist.");
		expect(wrapper.find('a[href="/"]').exists()).toBe(true);
	});

	it('says something went wrong, not that the page is missing, for any other error', async () => {
		const wrapper = await mountSuspended(ErrorPage, {
			props: { error: createError({ statusCode: 500, message: 'boom' }) }
		});
		expect(wrapper.text()).toContain('Something Went Wrong');
		expect(wrapper.text()).not.toContain("doesn't exist");
		expect(wrapper.find('a[href="/"]').exists()).toBe(true);
	});
});
