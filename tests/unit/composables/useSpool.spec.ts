import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { useSpool } from '~/composables/useSpool';

const Probe = defineComponent({
	setup() {
		useSpool();
		return () => h('div');
	}
});

const runtime = () => useRuntimeConfig().public as { spool: boolean };

afterEach(() => {
	runtime().spool = false;
	document.querySelectorAll('script[data-spool-client]').forEach((node) => node.remove());
});

describe('useSpool', () => {
	it('adds no page runtime while the SPOOL setting is off', async () => {
		runtime().spool = false;
		await mountSuspended(Probe);
		expect(document.querySelector('script[data-spool-client]')).toBeNull();
	});

	it('adds the page runtime from the site own copy when the setting is on', async () => {
		runtime().spool = true;
		await mountSuspended(Probe);
		await vi.waitFor(() => {
			const script = document.querySelector<HTMLScriptElement>('script[data-spool-client]');
			expect(script?.getAttribute('src')).toBe('/client.js');
			expect(script?.defer).toBe(true);
		});
	});
});
