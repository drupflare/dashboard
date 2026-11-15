import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Install from '~/components/site/module/Install.vue';
import Row from '~/components/site/module/Row.vue';
import Search from '~/components/site/module/Search.vue';
import Strata from '~/components/site/module/Strata.vue';
import type { ModuleListItem } from '~/shared/modules';
import type { StrataStatus } from '~/shared/strata';

const mounted: { unmount: () => void }[] = [];

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	vi.restoreAllMocks();
});

const row = (overrides: Partial<ModuleListItem> = {}): ModuleListItem => ({
	name: 'drupal/token',
	label: 'Token',
	kind: 'unknown',
	state: 'verified',
	shipping: false,
	needs: [],
	installed: null,
	...overrides
});

async function mountRow(item: ModuleListItem, checking = false) {
	const wrapper = await mountSuspended(Row, { props: { row: item, checking } });
	mounted.push(wrapper);
	return wrapper;
}

const buttonNamed = (wrapper: { findAll: (s: string) => any[] }, text: string) =>
	wrapper.findAll('button').find((button) => button.text().trim() === text);

describe('module row', () => {
	it('reads a verified row as verified with a one-click check', async () => {
		const wrapper = await mountRow(row());
		expect(wrapper.text()).toContain('Verified');
		await buttonNamed(wrapper, 'Check')?.trigger('click');
		expect(wrapper.emitted('check')?.[0]).toEqual([row()]);
	});

	it('asks for a second click before checking an untested row', async () => {
		const wrapper = await mountRow(row({ state: 'untested' }));
		await buttonNamed(wrapper, 'Check')?.trigger('click');
		expect(wrapper.emitted('check')).toBeUndefined();
		expect(wrapper.text()).toContain('never been run on a site');
		await buttonNamed(wrapper, 'Check Anyway')?.trigger('click');
		expect(wrapper.emitted('check')).toHaveLength(1);
	});

	it('shows a blocked row with its reason and a disabled check', async () => {
		const wrapper = await mountRow(
			row({ state: 'blocked', reason: 'needs a socket exchange', name: 'drupal/redis' })
		);
		expect(wrapper.text()).toContain('Blocked');
		expect(wrapper.text()).toContain('needs a socket exchange');
		expect(buttonNamed(wrapper, 'Check')?.attributes('disabled')).toBeDefined();
	});

	it('reads a shipped module as included with no check', async () => {
		const wrapper = await mountRow(row({ shipping: true }));
		expect(wrapper.text()).toContain('Included');
		expect(buttonNamed(wrapper, 'Included')?.attributes('disabled')).toBeDefined();
	});
});

describe('module row actions', () => {
	it('offers Enable for a module that ships with every site', async () => {
		const wrapper = await mountRow(row({ shipping: true }));
		await buttonNamed(wrapper, 'Enable')?.trigger('click');
		expect(wrapper.emitted('enable')?.[0]).toEqual([row({ shipping: true })]);
	});

	it('offers no Enable for a module that is not in the pack', async () => {
		const wrapper = await mountRow(row());
		expect(buttonNamed(wrapper, 'Enable')).toBeUndefined();
	});

	it('asks for a second click before it removes a module', async () => {
		const wrapper = await mountRow(row());
		await buttonNamed(wrapper, 'Remove')?.trigger('click');
		expect(wrapper.emitted('remove')).toBeUndefined();
		expect(wrapper.text()).toContain('A restore point is taken first.');
		await buttonNamed(wrapper, 'Confirm Remove')?.trigger('click');
		expect(wrapper.emitted('remove')?.[0]).toEqual([row()]);
	});

	it('offers no Remove for a blocked module', async () => {
		const wrapper = await mountRow(row({ state: 'blocked', reason: 'no' }));
		expect(buttonNamed(wrapper, 'Remove')).toBeUndefined();
	});
});

const operation = (type: string, status: string, steps: object[] = []) =>
	({
		id: 'op_aaaaaaaa',
		type,
		status,
		steps,
		targetIds: ['site_1'],
		rollbackPoint: 'bkp_1'
	}) as never;

const passing = {
	ok: true,
	conflicts: [],
	message: 'No conflicts. The site can take this module.'
};

const installProps = (over: Record<string, unknown> = {}): never =>
	({
		name: 'drupal/paragraphs',
		state: 'verified',
		shipping: false,
		check: null,
		checking: false,
		install: null,
		enable: null,
		starting: null,
		error: null,
		...over
	}) as never;

describe('module install steps', () => {
	it('shows the verdict and its conflicts, with Install held back', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({
				check: {
					ok: false,
					message:
						'Installing this module would conflict with the code the site already has.',
					conflicts: [
						{
							requires: 'php',
							constraint: '^8.4',
							installed: '8.3',
							reason: 'version'
						},
						{ requires: 'ext-zip', constraint: '*', installed: null, reason: 'missing' }
					]
				}
			})
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Install drupal/paragraphs');
		expect(wrapper.text()).toContain('would conflict');
		expect(wrapper.text()).toContain('the site has 8.3');
		expect(wrapper.text()).toContain('which the site does not have');
		expect(wrapper.text()).toContain('A restore point of the site is saved first');
		expect(buttonNamed(wrapper, 'Run Check')).toBeDefined();
		expect(buttonNamed(wrapper, 'Install')?.attributes('disabled')).toBeDefined();
	});

	it('emits run from the Check action', async () => {
		const wrapper = await mountSuspended(Install, { props: installProps() });
		mounted.push(wrapper);
		await buttonNamed(wrapper, 'Run Check')?.trigger('click');
		expect(wrapper.emitted('run')).toHaveLength(1);
	});

	it('enables Install after a passing check and emits it without a confirmation', async () => {
		const wrapper = await mountSuspended(Install, { props: installProps({ check: passing }) });
		mounted.push(wrapper);
		await buttonNamed(wrapper, 'Install')?.trigger('click');
		expect(wrapper.emitted('install')?.[0]).toEqual([false]);
	});

	it('holds an untested module until the owner confirms it, then emits the confirmation', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({ check: passing, state: 'untested' })
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('never been run on a site');
		expect(buttonNamed(wrapper, 'Install')?.attributes('disabled')).toBeDefined();
		await wrapper.find('input[type="checkbox"], button[role="checkbox"]').trigger('click');
		await buttonNamed(wrapper, 'Install')?.trigger('click');
		expect(wrapper.emitted('install')?.[0]).toEqual([true]);
	});

	it('says a module in the pack needs no install', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({ check: passing, shipping: true })
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('nothing to install');
		expect(buttonNamed(wrapper, 'Install')?.attributes('disabled')).toBeDefined();
	});

	it('names the running step and shows the restore point once it is saved', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({
				check: passing,
				install: operation('module.install', 'running', [
					{ id: 'restore-point-record', state: 'succeeded' },
					{ id: 'install', state: 'running' }
				])
			})
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Installing the module.');
		expect(wrapper.text()).toContain(
			'A restore point of the site was saved before the change.'
		);
		expect(buttonNamed(wrapper, 'Install')?.attributes('disabled')).toBeDefined();
	});

	it('shows success for the install and the enable', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({
				check: passing,
				install: operation('module.install', 'succeeded'),
				enable: operation('module.enable', 'succeeded')
			})
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('The module is installed. Enable it to turn it on.');
		expect(wrapper.text()).toContain('The module is on.');
	});

	it('shows the site reason for a failed install, without a code', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({
				check: passing,
				install: operation('module.install', 'failed', [
					{
						id: 'install',
						state: 'failed',
						error: 'install_failed: The site could not install drupal/paragraphs.'
					}
				])
			})
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('The site could not install drupal/paragraphs.');
		expect(wrapper.text()).not.toContain('install_failed');
	});

	it('emits enable, and shows a failed enable', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({
				enable: operation('module.enable', 'failed', [
					{
						id: 'preflight',
						state: 'failed',
						error: 'module_missing: The module is not on the site yet. Install it first.'
					}
				])
			})
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Install it first.');
		await buttonNamed(wrapper, 'Enable')?.trigger('click');
		expect(wrapper.emitted('enable')).toHaveLength(1);
	});

	it('shows an error from starting a change', async () => {
		const wrapper = await mountSuspended(Install, {
			props: installProps({ error: 'The module could not be started.' })
		});
		mounted.push(wrapper);
		expect(wrapper.find('[role="alert"]').text()).toBe('The module could not be started.');
	});
});

describe('strata add-on row', () => {
	it('names the census state and says it is optional and not a backup replacement', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: {
				included: null,
				unlockPlan: null,
				state: 'verified',
				free: false,
				status: null
			}
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Optional Add-On');
		expect(wrapper.text()).toContain('Verified');
		expect(wrapper.text()).toContain('Drupal sites only');
		expect(wrapper.text()).toContain('does not replace the platform backups');
	});

	it('says the plan includes it when the entitlement does', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: {
				included: true,
				unlockPlan: null,
				state: 'verified',
				free: false,
				status: null
			}
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('included on this plan');
	});

	it('starts straight away on a paid plan', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: {
				included: true,
				unlockPlan: null,
				state: 'verified',
				free: false,
				status: null
			}
		});
		mounted.push(wrapper);
		await buttonNamed(wrapper, 'Set Up Strata')?.trigger('click');
		expect(wrapper.emitted('start')).toHaveLength(1);
		expect(wrapper.find('[data-test="strata-free-warning"]').exists()).toBe(false);
	});

	it('warns on the free plan and starts only after the owner turns it on', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: { included: true, unlockPlan: null, state: 'verified', free: true, status: null }
		});
		mounted.push(wrapper);
		await buttonNamed(wrapper, 'Set Up Strata')?.trigger('click');
		expect(wrapper.emitted('start')).toBeUndefined();
		expect(wrapper.find('[data-test="strata-free-warning"]').text()).toContain(
			'daily write allowance'
		);
		await buttonNamed(wrapper, 'Cancel')?.trigger('click');
		expect(wrapper.find('[data-test="strata-free-warning"]').exists()).toBe(false);
		await buttonNamed(wrapper, 'Set Up Strata')?.trigger('click');
		await buttonNamed(wrapper, 'Turn On Strata')?.trigger('click');
		expect(wrapper.emitted('start')).toHaveLength(1);
	});

	it('does not warn again once the free confirmation is on record', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: {
				included: true,
				unlockPlan: null,
				state: 'verified',
				free: true,
				status: {
					allocation: 'light',
					capturesStatements: false,
					recoverySeconds: 900,
					applied: false,
					confirmedFreeAt: 1,
					store: 'none',
					storeReason: null,
					storage: null
				}
			}
		});
		mounted.push(wrapper);
		await buttonNamed(wrapper, 'Set Up Strata')?.trigger('click');
		expect(wrapper.emitted('start')).toHaveLength(1);
	});

	it('offers every allocation on a paid plan and only light on free', async () => {
		const status: StrataStatus = {
			allocation: 'light',
			capturesStatements: false,
			recoverySeconds: 900,
			applied: true,
			confirmedFreeAt: null,
			store: 'none',
			storeReason: null,
			storage: null
		};
		const paid = await mountSuspended(Strata, {
			props: { included: true, unlockPlan: null, state: 'verified', free: false, status }
		});
		mounted.push(paid);
		const paidRadios = paid.findAll('input[type="radio"]');
		expect(paidRadios).toHaveLength(2);
		expect(paidRadios.every((radio) => radio.attributes('disabled') === undefined)).toBe(true);
		await paidRadios[1]!.trigger('change');
		expect(paid.emitted('allocate')?.[0]).toEqual(['detailed']);

		const free = await mountSuspended(Strata, {
			props: {
				included: true,
				unlockPlan: null,
				state: 'verified',
				free: true,
				status: { ...status, allocation: 'light' }
			}
		});
		mounted.push(free);
		const disabled = free
			.findAll('input[type="radio"]')
			.map((radio) => radio.attributes('disabled') !== undefined);
		expect(disabled).toEqual([false, true]);
	});

	it('says when the site has not accepted the setting', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: {
				included: true,
				unlockPlan: null,
				state: 'verified',
				free: false,
				status: {
					allocation: 'light',
					capturesStatements: false,
					recoverySeconds: 900,
					applied: false,
					confirmedFreeAt: null,
					store: 'none',
					storeReason: null,
					storage: null
				}
			}
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('has not accepted this setting yet');

		await wrapper.get('[data-test="strata-retry"]').trigger('click');
		expect(wrapper.emitted('allocate')?.[0]).toEqual(['light']);
	});

	it('offers no retry once the site has accepted the setting', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: {
				included: true,
				unlockPlan: null,
				state: 'verified',
				free: false,
				status: {
					allocation: 'detailed',
					capturesStatements: true,
					recoverySeconds: 900,
					applied: true,
					confirmedFreeAt: null,
					store: 'none',
					storeReason: null,
					storage: null
				}
			}
		});
		mounted.push(wrapper);
		expect(wrapper.find('[data-test="strata-retry"]').exists()).toBe(false);
	});

	describe('the store state', () => {
		const status = (patch: Partial<StrataStatus>): StrataStatus => ({
			allocation: 'light',
			capturesStatements: false,
			recoverySeconds: 900,
			applied: true,
			confirmedFreeAt: null,
			store: 'none',
			storeReason: null,
			storage: null,
			...patch
		});
		const mountWith = async (patch: Partial<StrataStatus>, managed: boolean | null = true) => {
			const wrapper = await mountSuspended(Strata, {
				props: {
					included: true,
					unlockPlan: null,
					state: 'verified',
					free: false,
					status: status(patch),
					managed
				}
			});
			mounted.push(wrapper);
			return wrapper;
		};

		it('says nothing about storage before one is set up', async () => {
			const wrapper = await mountWith({});
			expect(wrapper.find('[data-test="strata-store-ready"]').exists()).toBe(false);
			expect(wrapper.find('[data-test="strata-store-failed"]').exists()).toBe(false);
			expect(wrapper.find('[data-test="strata-store-self"]').exists()).toBe(false);
		});

		it('says where backups go once the store is ready', async () => {
			const wrapper = await mountWith({ store: 'ready' });
			expect(wrapper.get('[data-test="strata-store-ready"]').text()).toBe(
				"Backups go to a private bucket in Drupflare's storage."
			);
			expect(wrapper.find('[data-test="strata-store-retry"]').exists()).toBe(false);
		});

		it('says it could not be set up, gives the reason and offers Try Again', async () => {
			const wrapper = await mountWith({ store: 'failed', storeReason: 'token_quota' });
			const text = wrapper.get('[data-test="strata-store-failed"]').text();
			expect(text).toContain(
				'Storage could not be set up. Strata is on but not saving history.'
			);
			expect(text).toContain('The storage allowance for new sites is used up.');
			await wrapper.get('[data-test="strata-store-retry"]').trigger('click');
			expect(wrapper.emitted('retryStore')).toHaveLength(1);
		});

		it('leaves out the reason when the code is not one it knows', async () => {
			const wrapper = await mountWith({ store: 'failed', storeReason: 'something_new' });
			expect(wrapper.get('[data-test="strata-store-failed"]').text()).not.toContain(
				'something_new'
			);
		});

		it('says a self-managed site stores where its owner points it', async () => {
			const wrapper = await mountWith({ store: 'ready' }, false);
			expect(wrapper.get('[data-test="strata-store-self"]').text()).toBe(
				"Strata stores where you point it. Drupflare's own backups stay the default."
			);
			expect(wrapper.find('[data-test="strata-store-ready"]').exists()).toBe(false);
			expect(wrapper.find('[data-test="strata-storage-note"]').exists()).toBe(false);
		});

		it.each([
			['needs_object_storage', 'Needs Object Storage.', 'Turn on R2'],
			['needs_wider_token', 'Needs a Wider Token.', 'Workers R2 Storage Edit']
		] as const)(
			'tells a self-managed owner what to fix for %s',
			async (storage, label, action) => {
				const wrapper = await mountWith({ storage }, false);
				const note = wrapper.get('[data-test="strata-storage-note"]').text();
				expect(note).toContain(label);
				expect(note).toContain(action);
			}
		);

		it('adds no note when the account is ready', async () => {
			const wrapper = await mountWith({ storage: 'ok' }, false);
			expect(wrapper.find('[data-test="strata-storage-note"]').exists()).toBe(false);
		});
	});

	it('names the unlocking plan for a free plan when one is stated', async () => {
		const wrapper = await mountSuspended(Strata, {
			props: {
				included: false,
				unlockPlan: 'Managed Studio',
				state: 'verified',
				free: true,
				status: null
			}
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('The Managed Studio plan includes it');
	});
});

describe('module search', () => {
	it('renders the search field and the state filter', async () => {
		const wrapper = await mountSuspended(Search, {
			props: { q: '', state: undefined, 'onUpdate:q': () => undefined }
		});
		mounted.push(wrapper);
		expect(wrapper.text()).toContain('Search Modules');
		expect(wrapper.text()).toContain('State');
	});
});
