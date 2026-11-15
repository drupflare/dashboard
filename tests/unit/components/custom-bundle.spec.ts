import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import Findings from '~/components/onboarding/custom/Findings.vue';
import Upgrade from '~/components/onboarding/custom/Upgrade.vue';
import type { Finding } from '~/shared/recipes';

const finding = (severity: Finding['severity'], code: string, subject: string): Finding => ({
	severity,
	code,
	subject,
	reason: 'engine wording that the page does not show',
	provenance: { source: `wrangler.jsonc:${subject}` }
});

describe('OnboardingCustomFindings', () => {
	it('says what to change for a refused item and leaves create to the page', async () => {
		const wrapper = await mountSuspended(Findings, {
			props: {
				deployable: false,
				findings: [
					finding('blocking', 'main-not-built', 'main'),
					finding('warning', 'cron-not-applied', 'triggers.crons')
				]
			}
		});
		const text = wrapper.text();
		expect(text).toContain('cannot be deployed yet');
		expect(text).toContain('The entry file is source code');
		expect(text).toContain('In main');
		expect(text).toContain('Build your project');
		expect(text).toContain('Schedules will not run');
		expect(text).not.toContain('engine wording');
		expect(wrapper.find('ul[aria-label="Items to fix"]').exists()).toBe(true);
	});

	it('shows a deployable bundle with only the things to know', async () => {
		const wrapper = await mountSuspended(Findings, {
			props: { deployable: true, findings: [finding('info', 'limits-ignored', 'limits')] }
		});
		expect(wrapper.text()).toContain('This bundle can be deployed.');
		expect(wrapper.text()).toContain('Limits are ignored');
		expect(wrapper.find('ul[aria-label="Items to fix"]').exists()).toBe(false);
	});

	it('falls back to a plain line for a code it does not know', async () => {
		const wrapper = await mountSuspended(Findings, {
			props: { deployable: false, findings: [finding('blocking', 'brand-new', 'x')] }
		});
		expect(wrapper.text()).toContain('Something in the bundle needs a look');
	});
});

describe('OnboardingCustomUpgrade', () => {
	it('names the plan that includes custom code', async () => {
		const wrapper = await mountSuspended(Upgrade, { props: { planName: 'Managed Site' } });
		expect(wrapper.text()).toContain('part of the Managed Site plan');
		expect(wrapper.text()).toContain('Nothing was stored');
		expect(wrapper.find('a[href="/org/billing"]').exists()).toBe(true);
	});

	it('still reads right when no plan is named', async () => {
		const wrapper = await mountSuspended(Upgrade, { props: { planName: null } });
		expect(wrapper.text()).toContain('needs a paid plan');
	});
});
