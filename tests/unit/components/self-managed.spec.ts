import { mountSuspended } from '@nuxt/test-utils/runtime';
import { describe, expect, it } from 'vitest';
import Connect from '~/components/onboarding/self-managed/Connect.vue';
import Create from '~/components/onboarding/self-managed/Create.vue';
import Report from '~/components/onboarding/self-managed/Report.vue';
import type { ProbeCapability, ProbeReport } from '~/shared/cloudflare-probe';
import type { PlaneConnectionView } from '~/shared/plane-connections';

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

	it('tells an account without a card that object storage is off and what that costs', async () => {
		const wrapper = await mountSuspended(Report, {
			props: {
				report: {
					...base,
					capabilities: [row('storage', 'not-enabled', 'Object storage')]
				}
			}
		});
		expect(wrapper.text()).toContain('Not turned on');
		expect(wrapper.text()).toContain('payment card');
		expect(wrapper.text()).toContain('Strata backups stay off');
		expect(wrapper.text()).not.toContain('Add the permission');
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

	it('offers to connect a token that can edit scripts and says which token it keeps', async () => {
		const narrower = await mountSuspended(Report, {
			props: {
				report: {
					...base,
					canDownscope: true,
					capabilities: [row('scripts', 'granted', 'Site scripts')]
				}
			}
		});
		expect(narrower.text()).toContain('makes a narrower one');
		expect(narrower.text()).toContain('does not keep this token');
		const button = narrower
			.findAll('button')
			.find((item) => item.text() === 'Connect This Account');
		await button?.trigger('click');
		expect(narrower.emitted('connect')).toEqual([['acc_1']]);

		const whole = await mountSuspended(Report, {
			props: {
				report: { ...base, capabilities: [row('scripts', 'granted', 'Site scripts')] }
			}
		});
		expect(whole.text()).toContain('keeps this token sealed');
		expect(whole.text()).toContain('keeps every permission you gave it');
	});

	it('does not offer to connect a token that cannot edit scripts', async () => {
		const wrapper = await mountSuspended(Report, {
			props: {
				report: { ...base, capabilities: [row('scripts', 'missing', 'Site scripts')] }
			}
		});
		expect(wrapper.text()).not.toContain('Connect This Account');
		expect(wrapper.text()).toContain('cannot edit Workers scripts');
	});

	it('does not offer to connect an expired token', async () => {
		const wrapper = await mountSuspended(Report, {
			props: {
				report: {
					...base,
					status: 'expired',
					capabilities: [row('scripts', 'granted', 'S')]
				}
			}
		});
		expect(wrapper.text()).not.toContain('Connect This Account');
	});

	it('says nothing is saved until the account is connected', async () => {
		const wrapper = await mountSuspended(Report, { props: { report: base } });
		expect(wrapper.text()).toContain('Nothing is saved until you connect the account');
	});
});

describe('OnboardingSelfManagedCreate', () => {
	const connection = (over: Partial<PlaneConnectionView> = {}): PlaneConnectionView => ({
		id: 'pcn_1',
		provider: 'cloudflare',
		accountId: 'a'.repeat(32),
		accountName: 'Campus Site',
		tokenKind: 'user',
		expiresOn: null,
		state: 'active',
		capabilities: [row('storage', 'granted', 'Object storage')],
		workersSubdomain: 'acme',
		narrowerToken: true,
		createdAt: 1,
		lastValidatedAt: 2,
		revokedAt: null,
		...over
	});

	const mountCreate = (items: PlaneConnectionView[], extra: Record<string, unknown> = {}) =>
		mountSuspended(Create, { props: { connections: items, busy: false, ...extra } });

	it('creates on the account workers.dev address with the chosen type and name', async () => {
		const wrapper = await mountCreate([connection()]);
		await wrapper.find('#self-managed-kind').setValue('nuxtpress');
		await wrapper.find('#self-managed-name').setValue('calm-river-stone');
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')).toEqual([
			[{ kind: 'nuxtpress', name: 'calm-river-stone', connectionId: 'pcn_1' }]
		]);
		expect(wrapper.text()).toContain('.acme.workers.dev');
	});

	it('refuses a bad name and sends nothing', async () => {
		const wrapper = await mountCreate([connection()]);
		await wrapper.find('#self-managed-name').setValue('A');
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')).toBeUndefined();
		expect(wrapper.find('[role="alert"]').text()).toContain('Use 3 to 63 lowercase letters');
	});

	it('sends a hostname on the customer zone with its zone ID', async () => {
		const wrapper = await mountCreate([connection()]);
		await wrapper.find('input[value="own"]').setValue(true);
		await wrapper.find('#self-managed-name').setValue('calm-river-stone');
		await wrapper.find('#self-managed-host').setValue('WWW.Example.org');
		await wrapper.find('#self-managed-zone').setValue('e'.repeat(32));
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({
			customHost: { hostname: 'www.example.org', zoneId: 'e'.repeat(32) }
		});
	});

	it('refuses an own hostname without a valid zone ID', async () => {
		const wrapper = await mountCreate([connection()]);
		await wrapper.find('input[value="own"]').setValue(true);
		await wrapper.find('#self-managed-name').setValue('calm-river-stone');
		await wrapper.find('#self-managed-host').setValue('not a host');
		await wrapper.find('#self-managed-zone').setValue('short');
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')).toBeUndefined();
		const alerts = wrapper.findAll('[role="alert"]').map((item) => item.text());
		expect(alerts.join(' ')).toContain('Enter a hostname');
		expect(alerts.join(' ')).toContain('zone ID is 32 letters and numbers');
	});

	it('blocks the workers.dev address when the account has no subdomain', async () => {
		const wrapper = await mountCreate([connection({ workersSubdomain: null })]);
		expect(wrapper.text()).toContain('no workers.dev subdomain');
		expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined();
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')).toBeUndefined();
	});

	it('says why a site runs without object storage when the account has none on', async () => {
		const wrapper = await mountCreate([
			connection({ capabilities: [row('storage', 'not-enabled', 'Object storage')] })
		]);
		expect(wrapper.text()).toContain('no object storage turned on');
		expect(wrapper.text()).toContain('Strata off-site backups');
		const granted = await mountCreate([connection()]);
		expect(granted.text()).not.toContain('no object storage turned on');
	});

	it('lets the owner pick between accounts and sends the chosen one', async () => {
		const wrapper = await mountCreate([
			connection(),
			connection({ id: 'pcn_2', accountName: 'Second Site' })
		]);
		await wrapper.find('#self-managed-connection').setValue('pcn_2');
		await wrapper.find('#self-managed-name').setValue('calm-river-stone');
		await wrapper.find('form').trigger('submit');
		expect(wrapper.emitted('submit')?.[0]?.[0]).toMatchObject({ connectionId: 'pcn_2' });
	});

	it('shows the server refusal as an alert', async () => {
		const wrapper = await mountCreate([connection()], {
			error: 'That account is not connected.'
		});
		expect(wrapper.find('[role="alert"]').text()).toContain('That account is not connected.');
	});
});
