import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import Connect from '~/components/onboarding/self-managed/Connect.vue';
import Report from '~/components/onboarding/self-managed/Report.vue';
import type { ProbeCapability, ProbeReport } from '~/shared/cloudflare-probe';

const row = (
	id: ProbeCapability['id'],
	state: ProbeCapability['state'],
	label: string
): ProbeCapability => ({
	id,
	label,
	state,
	permission: 'Workers Scripts Edit',
	retryHint:
		state === 'unknown'
			? 'Cloudflare did not answer this check. Try again in a few minutes.'
			: null
});

const base: ProbeReport = {
	status: 'active',
	kind: 'account',
	tokenId: null,
	expiresOn: null,
	accounts: [{ id: 'acc_1', name: 'Campus Site' }],
	account: { id: 'acc_1', name: 'Campus Site' },
	capabilities: [],
	canDownscope: false
};

describe('OnboardingSelfManagedConnect', () => {
	it('keeps the check button off until a token is pasted', async () => {
		const wrapper = await mountSuspended(Connect, { props: { token: '', busy: false } });
		expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
	});

	it('emits submit with a token in place', async () => {
		const wrapper = await mountSuspended(Connect, { props: { token: 'abc', busy: false } });
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')).toHaveLength(1);
	});

	it('shows the checking label while the probe runs', async () => {
		const wrapper = await mountSuspended(Connect, { props: { token: 'abc', busy: true } });
		expect(wrapper.text()).toContain('Checking Token');
	});

	it('shows the refusal as an alert', async () => {
		const wrapper = await mountSuspended(Connect, {
			props: {
				token: 'abc',
				busy: false,
				error: 'That account is not visible to this token.'
			}
		});
		expect(wrapper.find('[role="alert"]').text()).toContain('That account is not visible');
	});

	it('links to the token form with the permissions prefilled', async () => {
		const wrapper = await mountSuspended(Connect, { props: { token: '', busy: false } });
		const href = wrapper.find('a').attributes('href') ?? '';
		expect(
			href.startsWith(
				'https://dash.cloudflare.com/?to=/:account/api-tokens&permissionGroupKeys='
			)
		).toBe(true);
	});
});

describe('OnboardingSelfManagedReport', () => {
	it('shows granted rows with text next to the icon', async () => {
		const wrapper = await mountSuspended(Report, {
			props: {
				report: {
					...base,
					status: 'active',
					capabilities: [row('scripts', 'granted', 'Site scripts')]
				}
			}
		});
		expect(wrapper.text()).toContain('The token is active.');
		expect(wrapper.text()).toContain('Site scripts');
		expect(wrapper.text()).toContain('Granted');
		expect(wrapper.text()).not.toContain('Missing');
	});

	it('names the permission to add for a missing row', async () => {
		const wrapper = await mountSuspended(Report, {
			props: {
				report: {
					...base,
					capabilities: [
						{
							...row('storage', 'missing', 'Object storage'),
							permission: 'Workers R2 Storage Edit'
						}
					]
				}
			}
		});
		expect(wrapper.text()).toContain('Add the permission "Workers R2 Storage Edit"');
	});

	it('gives the retry hint for a row it could not check', async () => {
		const wrapper = await mountSuspended(Report, {
			props: { report: { ...base, capabilities: [row('databases', 'unknown', 'Databases')] } }
		});
		expect(wrapper.text()).toContain('Could not check');
		expect(wrapper.text()).toContain('Try again in a few minutes.');
	});

	it('shows an expired token without any rows', async () => {
		const wrapper = await mountSuspended(Report, {
			props: {
				report: { ...base, status: 'expired', kind: 'user', accounts: [], account: null }
			}
		});
		expect(wrapper.text()).toContain('The token has expired.');
		expect(wrapper.find('ul').exists()).toBe(false);
	});

	it('says so when the token sees no accounts', async () => {
		const wrapper = await mountSuspended(Report, {
			props: { report: { ...base, accounts: [], account: null } }
		});
		expect(wrapper.text()).toContain('cannot see any accounts');
	});

	it('lets the caller pick an account and emits the choice', async () => {
		const wrapper = await mountSuspended(Report, {
			props: {
				report: {
					...base,
					accounts: [
						{ id: 'acc_1', name: 'Campus Site' },
						{ id: 'acc_2', name: 'Second Site' }
					]
				}
			}
		});
		await wrapper.find('select').setValue('acc_2');
		const button = wrapper
			.findAll('button')
			.find((item) => item.text() === 'Check This Account');
		await button?.trigger('click');
		expect(wrapper.emitted('choose')).toEqual([['acc_2']]);
	});
});
