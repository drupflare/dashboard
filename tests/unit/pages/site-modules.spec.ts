import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ModulesPage from '~/pages/sites/[id]/modules.vue';
import { useBillingStore } from '~/stores/billing';
import { poll, useModulesStore } from '~/stores/modules';
import { useOperationsStore } from '~/stores/operations';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_personal';
const SITE = 'site_modules001';
const base = `/api/v1/orgs/${ORG}/sites/${SITE}/modules`;

const site = {
	id: SITE,
	orgId: ORG,
	name: 'Campus Site',
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	accountId: null,
	state: 'active',
	ring: 'R1',
	primaryHostname: 'www.example.edu',
	hostnames: [],
	admin: { username: null, email: null, password: 'unknown' },
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
};

const row = (name: string, label: string, state = 'verified', shipping = false) => ({
	name,
	label,
	kind: 'unknown',
	state,
	shipping,
	needs: [],
	installed: null
});

const LIST = [
	row('drupal/token', 'Token', 'verified', true),
	row('drupal/paragraphs', 'Paragraphs', 'untested')
];
const STRATA = row('earth-app/strata', 'Strata');

let listReply: () => Reply;
let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	poll.ms = 0;
	navigate.mockReset();
	useOperationsStore().reset();
	clearBrowserState();
	useSessionStore().$reset();
	useModulesStore().$reset();
	useBillingStore().$reset();
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null
	} as never;
	listReply = () => ({ body: { items: LIST } });
	cleanup = registerApi({
		'GET /api/v1/me': {
			body: {
				id: 'usr_1',
				email: 'owner@example.test',
				displayName: null,
				via: 'session',
				stepUpUntil: null
			}
		},
		[`GET /api/v1/sites/${SITE}`]: { body: site },
		[`GET /api/v1/orgs/${ORG}/entitlement`]: {
			body: {
				planId: 'managed-free',
				addOns: [],
				sites: 3,
				views: null,
				billingAccount: false,
				features: { strata: false }
			}
		},
		[`GET ${base}`]: (call) =>
			call.query.q === 'strata' ? { body: { items: [STRATA] } } : listReply()
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(ModulesPage, { route: `/sites/${SITE}/modules` });
	mounted.push(wrapper);
	return wrapper;
}

describe('modules page', () => {
	it('lists the census rows and the Strata add-on for a free plan', async () => {
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Paragraphs'));
		expect(wrapper.text()).toContain('Token');
		expect(wrapper.text()).toContain('Included');
		expect(wrapper.text()).toContain('Strata is not included on this plan.');
		expect(
			calls.some((call) => call.path === base && Object.keys(call.query).length === 0)
		).toBe(true);
	});

	it('shows the empty state when the search matches nothing', async () => {
		listReply = () => ({ body: { items: [] } });
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('No modules match this search.'));
		expect(wrapper.text()).toContain('No modules match this search.');
	});

	it('shows the error state when the list fails', async () => {
		listReply = () => failure('internal', 'boom', 'req_1');
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('could not be loaded'));
		expect(wrapper.text()).toContain('The module list could not be loaded.');
	});

	it('runs a check and shows the verdict below the list', async () => {
		let checked = false;
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': {
				body: {
					id: 'usr_1',
					email: 'owner@example.test',
					displayName: null,
					via: 'session',
					stepUpUntil: null
				}
			},
			[`GET /api/v1/sites/${SITE}`]: { body: site },
			[`GET /api/v1/orgs/${ORG}/entitlement`]: {
				body: {
					planId: 'managed-free',
					addOns: [],
					sites: 3,
					views: null,
					billingAccount: false,
					features: { strata: false }
				}
			},
			[`GET ${base}`]: (call) =>
				call.query.q === 'strata' ? { body: { items: [STRATA] } } : listReply(),
			[`POST ${base}/check`]: () => {
				checked = true;
				return {
					body: {
						ok: true,
						conflicts: [],
						message: 'No conflicts. The site can take this module.'
					}
				};
			}
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Paragraphs'));
		const find = (text: string) =>
			wrapper.findAll('button').find((candidate) => candidate.text().trim() === text);
		// paragraphs is untested, so its first click only asks for the second one
		await find('Check')?.trigger('click');
		await find('Check Anyway')?.trigger('click');
		await waitFor(() => checked && wrapper.text().includes('No conflicts'));
		expect(wrapper.text()).toContain('Install drupal/paragraphs');
		expect(wrapper.text()).toContain('No conflicts. The site can take this module.');
		expect(useModulesStore().checks.get(`${SITE}|drupal/paragraphs`)?.ok).toBe(true);
	});
});

const op = (type: string, status: string, steps: object[] = []) => ({
	id: 'op_aaaaaaaa',
	type,
	status,
	steps,
	targetIds: [SITE]
});

describe('modules page changes', () => {
	const opPath = `GET /api/v1/orgs/${ORG}/operations/op_aaaaaaaa`;
	let extra: () => void = () => undefined;
	afterEach(() => extra());

	const find = (wrapper: { findAll: (s: string) => any[] }, text: string) =>
		wrapper.findAll('button').find((candidate) => candidate.text().trim() === text);

	const checked = {
		ok: true,
		conflicts: [],
		message: 'No conflicts. The site can take this module.'
	};

	it('installs a checked module, follows the operation and shows the restore point', async () => {
		let reads = 0;
		extra = registerApi({
			[`POST ${base}/check`]: { body: checked },
			[`POST ${base}/install`]: { status: 202, body: op('module.install', 'planned') },
			[opPath]: () => ({
				body:
					++reads < 2
						? op('module.install', 'running', [
								{ id: 'restore-point-record', state: 'succeeded' },
								{ id: 'install', state: 'running' }
							])
						: op('module.install', 'succeeded', [
								{ id: 'restore-point-record', state: 'succeeded' }
							])
			})
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Paragraphs'));
		await find(wrapper, 'Check')?.trigger('click');
		await find(wrapper, 'Check Anyway')?.trigger('click');
		await waitFor(() => wrapper.text().includes('No conflicts'));
		await wrapper.find('input[type="checkbox"], button[role="checkbox"]').trigger('click');
		await find(wrapper, 'Install')?.trigger('click');
		await waitFor(() => wrapper.text().includes('The module is installed.'));
		expect(wrapper.text()).toContain(
			'A restore point of the site was saved before the change.'
		);
		const start = calls.find((call) => call.path === `${base}/install`);
		expect(start?.body).toEqual({ name: 'drupal/paragraphs', confirm: true });
		expect(start?.headers['idempotency-key']).toBeTruthy();
	});

	it('enables a module that ships with every site from its row', async () => {
		extra = registerApi({
			[`POST ${base}/enable`]: { status: 202, body: op('module.enable', 'succeeded') }
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Paragraphs'));
		await find(wrapper, 'Enable')?.trigger('click');
		await waitFor(() => wrapper.text().includes('The module is on.'));
		expect(calls.find((call) => call.path === `${base}/enable`)?.body).toEqual({
			name: 'drupal/token'
		});
	});

	it('shows the error when a change cannot be started', async () => {
		extra = registerApi({
			[`POST ${base}/enable`]: {
				status: 422,
				body: { code: 'unprocessable', message: 'That module is not on the list.' }
			}
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Paragraphs'));
		await find(wrapper, 'Enable')?.trigger('click');
		await waitFor(() => wrapper.text().includes('That module is not on the list.'));
		expect(wrapper.find('[role="alert"]').text()).toBe('That module is not on the list.');
	});

	it('shows the refusal of a removal as the site gave it', async () => {
		extra = registerApi({
			[`POST ${base}/remove`]: {
				status: 422,
				body: { code: 'unprocessable', message: 'Removing Modules Needs a Worker Update' }
			}
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Paragraphs'));
		const removes = wrapper.findAll('button').filter((b) => b.text().trim() === 'Remove');
		await removes[1]?.trigger('click');
		await find(wrapper, 'Confirm Remove')?.trigger('click');
		await waitFor(() => wrapper.text().includes('Removing Modules Needs a Worker Update'));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('opens the progress screen once a removal starts', async () => {
		extra = registerApi({
			[`POST ${base}/remove`]: { status: 202, body: op('module.remove', 'planned') }
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Paragraphs'));
		const removes = wrapper.findAll('button').filter((b) => b.text().trim() === 'Remove');
		await removes[1]?.trigger('click');
		await find(wrapper, 'Confirm Remove')?.trigger('click');
		await waitFor(() => navigate.mock.calls.length > 0);
		expect(navigate).toHaveBeenCalledWith('/new/progress/op_aaaaaaaa');
	});
});

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
