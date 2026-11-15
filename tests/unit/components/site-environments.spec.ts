import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Create from '~/components/site/environment/Create.vue';
import Switcher from '~/components/site/environment/Switcher.vue';
import { SECRETS_NOT_CARRIED } from '~/shared/environments';
import { useEnvironmentsStore, type SiteEnvironment } from '~/stores/environments';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_a';
const SITE = 'site_1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const createPath = `POST /api/v1/orgs/${ORG}/sites/${SITE}/environments`;

function environment(overrides: Partial<SiteEnvironment> = {}): SiteEnvironment {
	return {
		id: 'env_1',
		kind: 'staging',
		name: 'quiet-river-staging',
		host: 'quiet-river-staging.drupflare.app',
		status: 'ready',
		sourceBackupId: null,
		ttlAt: null,
		createdAt: 1,
		...overrides
	};
}

const cleanups: (() => void)[] = [];
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useEnvironmentsStore().$reset();
	navigate.mockReset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanups.splice(0).forEach((cleanup) => cleanup());
});

async function mountSwitcher(environments: SiteEnvironment[], deleting: string | null = null) {
	const wrapper = await mountSuspended(Switcher, {
		props: {
			siteName: 'Quiet River',
			siteHost: 'quiet-river.drupflare.app',
			environments,
			deleting
		}
	});
	mounted.push(wrapper);
	return wrapper;
}

describe('environment switcher', () => {
	it('lists the live site first and each environment with its status in words', async () => {
		const wrapper = await mountSwitcher([
			environment(),
			environment({
				id: 'env_2',
				kind: 'dev',
				host: 'quiet-river-dev.drupflare.app',
				status: 'creating'
			})
		]);

		const items = wrapper.findAll('li');
		expect(items[0]!.text()).toContain('Live site');
		expect(items[1]!.text()).toContain('Staging');
		expect(items[1]!.text()).toContain('Ready');
		expect(items[2]!.text()).toContain('Dev');
		expect(items[2]!.text()).toContain('Creating');
	});

	it('opens a ready environment and not one that is still being made', async () => {
		const wrapper = await mountSwitcher([
			environment(),
			environment({ id: 'env_2', kind: 'dev', status: 'creating' })
		]);

		const opens = wrapper.findAll('a').map((link) => link.attributes('href'));
		expect(opens).toContain('https://quiet-river-staging.drupflare.app');
		expect(opens).not.toContain('https://quiet-river-dev.drupflare.app');
	});

	it('disables Delete while an environment is being made or removed and emits it otherwise', async () => {
		const wrapper = await mountSwitcher([
			environment(),
			environment({ id: 'env_2', kind: 'dev', status: 'deleting' })
		]);

		const deletes = wrapper.findAll('button').filter((button) => button.text() === 'Delete');
		expect(deletes[0]!.attributes('disabled')).toBeUndefined();
		expect(deletes[1]!.attributes('disabled')).toBeDefined();
		await deletes[0]!.trigger('click');
		expect(wrapper.emitted('remove')?.[0]).toEqual([environment()]);
	});
});

describe('create environment dialog', () => {
	async function openCreate(taken: string[] = []) {
		const wrapper = await mountSuspended(Create, {
			props: { orgId: ORG, siteId: SITE, taken: new Set(taken) }
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(document.querySelector('form')).not.toBeNull());
		return wrapper;
	}

	const submit = () =>
		document.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

	it('lists what stays behind on the copy', async () => {
		await openCreate();
		for (const item of SECRETS_NOT_CARRIED) expect(document.body.textContent).toContain(item);
	});

	it('starts on the kind the site does not have yet and disables the one it has', async () => {
		await openCreate(['staging']);
		const radios = [...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
		expect(radios.find((radio) => radio.value === 'staging')?.disabled).toBe(true);
		expect(radios.find((radio) => radio.value === 'dev')?.checked).toBe(true);
	});

	it('posts the kind with a fresh key and follows the operation', async () => {
		cleanups.push(
			registerApi({
				[createPath]: {
					status: 202,
					body: { environmentId: 'env_1', operation: { id: 'op_3' } }
				}
			})
		);
		await openCreate();

		submit();

		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_3'));
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.body).toEqual({ kind: 'staging' });
		expect(post?.headers['idempotency-key']).toMatch(UUID);
	});

	it('names the plan that includes environments when the plan does not', async () => {
		cleanups.push(
			registerApi({
				[createPath]: {
					status: 403,
					body: {
						code: 'forbidden',
						message: 'Your plan does not include staging and dev copies',
						details: { unlockedBy: { id: 'managed-site', name: 'Managed Site' } },
						requestId: 'req_test'
					}
				}
			})
		);
		await openCreate();

		submit();

		await vi.waitFor(() => expect(document.body.textContent).toContain('Managed Site plan'));
		expect(navigate).not.toHaveBeenCalled();
	});
});
