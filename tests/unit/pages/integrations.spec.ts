import { mockComponent, mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import IntegrationsPage from '~/pages/org/integrations.vue';
import { useOrgStore } from '~/stores/org';
import { useRepoConnectionsStore } from '~/stores/repo-connections';
import { useSessionStore } from '~/stores/session';
import { useSitesStore } from '~/stores/sites';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

// the real step-up form needs Turnstile and an email code; the page only has to hand over and take back control
mockComponent('AccountStepUp', {
	emits: ['done', 'cancel'],
	setup(_props: unknown, { emit }: { emit: (event: 'done' | 'cancel') => void }) {
		return () =>
			h(
				'button',
				{ type: 'button', 'data-step-up-done': '', onClick: () => emit('done') },
				'Finish Step Up'
			);
	}
});

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_personal';
const SITE = 'site_1';
const owner = { id: ORG, name: 'Personal', personal: true, role: 'owner' };
const developer = { ...owner, role: 'developer' };
const viewer = { ...owner, role: 'viewer' };
const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();

const listPath = `/api/v1/orgs/${ORG}/repo-connections`;
const reposPath = (id: string) => `${listPath}/${id}/repositories`;
const revokePath = (id: string) => `${listPath}/${id}/revoke`;
const sitesPath = `/api/v1/orgs/${ORG}/sites`;
const remotesPath = `/api/v1/orgs/${ORG}/sites/${SITE}/remotes`;

// the recorded call carries the method and the path, so a check names both
const sentTo = (method: string, path: string) =>
	calls.find((call) => call.method === method && call.path === path);

const github = {
	id: 'rc_1',
	provider: 'github',
	displayName: 'acme',
	scopes: [],
	state: 'active',
	createdAt: 1_700_000_000_000
};
const revoked = { ...github, id: 'rc_2', displayName: 'old-org', state: 'revoked' };
const site = { id: SITE, orgId: ORG, name: 'Campus Site' };
const repo = { fullName: 'acme/site', defaultBranch: 'trunk' };
const remote = (over: Record<string, unknown> = {}) => ({
	id: 'sr_1',
	siteId: SITE,
	connectionId: 'rc_1',
	repo: 'acme/site',
	branch: 'main',
	mountPath: 'modules/custom/site',
	intervalMinutes: 60,
	lastPullStatus: 'failed',
	lastPullAt: 1_700_000_000_000,
	createdAt: 1_700_000_000_000,
	...over
});
const notFound = (requestId: string) => ({
	status: 404,
	body: { code: 'not_found', message: 'Not found', details: {}, requestId }
});

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

function signIn(stepUpUntil: string | null) {
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil
	};
}

type Route = Reply | ((call: { path: string }) => Reply | Promise<Reply>);

function setup(options: {
	role?: typeof owner;
	connections?: Route;
	sites?: Route;
	remotes?: Route;
	start?: Route;
	revoke?: Route;
	attach?: Route;
}) {
	const routes: Record<string, unknown> = {
		'GET /api/v1/me': () => ({ body: { ...useSessionStore().me, via: 'session' } }),
		'GET /api/v1/me/organizations': {
			body: { items: [options.role ?? owner], nextCursor: null }
		},
		[`GET ${sitesPath}`]: options.sites ?? { body: { items: [site], nextCursor: null } },
		[`GET ${listPath}`]: options.connections ?? { body: { items: [github] } },
		[`GET ${remotesPath}`]: options.remotes ?? { body: { items: [] } },
		[`GET ${reposPath('rc_1')}`]: { body: { items: [repo] } }
	};
	if (options.start) routes[`POST ${listPath}`] = options.start;
	if (options.revoke) routes[`POST ${revokePath('rc_1')}`] = options.revoke;
	if (options.attach) routes[`POST ${remotesPath}`] = options.attach;
	cleanup = registerApi(routes as Parameters<typeof registerApi>[0]);
}

async function mountPage(route = '/org/integrations') {
	const wrapper = await mountSuspended(IntegrationsPage, { route, attachTo: document.body });
	mounted.push(wrapper);
	return wrapper;
}

type Mounted = Awaited<ReturnType<typeof mountPage>>;
const button = (wrapper: Mounted, text: string) =>
	wrapper.findAll('button').find((item) => item.text().trim() === text);
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const inDialog = (text: string) =>
	[...(dialog()?.querySelectorAll('button') ?? [])].find(
		(item) => item.textContent?.trim() === text
	);
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')];

// the Nuxt UI form field ties each label to its control by id
function fieldByLabel(wrapper: Mounted, label: string) {
	const id = wrapper
		.findAll('label')
		.find((item) => item.text().trim() === label)
		?.attributes('for');
	return wrapper.find(`[id="${id}"]`);
}

// the picker is a Nuxt UI select: open it from the keyboard, then choose the option by keyboard too
async function pickRepo(wrapper: Mounted) {
	const trigger = wrapper
		.findAll('button[role="combobox"]')
		.find((item) => item.text().includes('Choose a repository'));
	await trigger?.trigger('keydown', { key: 'ArrowDown' });
	await vi.waitFor(() => expect(options().length).toBeGreaterThan(0));
	const option = options().find((item) => item.textContent?.trim() === 'acme/site');
	option?.focus();
	option?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	await vi.waitFor(() => expect(trigger?.text()).toContain('acme/site'));
}

beforeEach(async () => {
	clearBrowserState();
	navigate.mockReset();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useSitesStore().$reset();
	useRepoConnectionsStore().$reset();
	signIn(soon());
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

describe('integrations page', () => {
	it('shows the GitHub connection with its Active state, a Revoke button and the providers that are coming soon', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('acme'));
		expect(wrapper.text()).toContain('Active');
		expect(button(wrapper, 'Revoke')).toBeDefined();
		expect(button(wrapper, 'Connect GitHub')?.attributes('disabled')).toBeUndefined();
		expect(
			wrapper.findAll('button').filter((item) => item.text().trim() === 'Coming Soon')
		).toHaveLength(4);
		expect(calls.filter((call) => call.path === listPath)).toHaveLength(1);
	});

	it('shows the loading state until the connections answer', async () => {
		setup({ connections: () => new Promise<Reply>(() => undefined) });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		expect(wrapper.text()).toContain('Loading connections');
	});

	it('shows a known-empty list as a prompt to connect GitHub', async () => {
		setup({ connections: { body: { items: [] } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Connections Yet'));
		expect(wrapper.text()).toContain(
			'Connect GitHub above to pick repositories for your sites.'
		);
	});

	it('shows a failed load with its message and request id, then loads again on Try Again', async () => {
		let healthy = false;
		setup({
			connections: () =>
				healthy
					? { body: { items: [github] } }
					: failure('internal', 'The list broke.', 'req_9')
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Connections'));
		expect(wrapper.text()).toContain('The list broke.');
		expect(wrapper.text()).toContain('req_9');
		healthy = true;
		await button(wrapper, 'Try Again')?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('acme'));
	});

	it('shows a missing organization as known absent without asking again', async () => {
		setup({ connections: notFound('req_4') });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Organization Found'));
		expect(calls.filter((call) => call.path === listPath)).toHaveLength(1);
	});

	it('shows a revoked connection without a Revoke button and says a provider must be connected before attaching', async () => {
		setup({ connections: { body: { items: [revoked] } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('old-org'));
		expect(wrapper.text()).toContain('Revoked');
		expect(button(wrapper, 'Revoke')).toBeUndefined();
		expect(wrapper.text()).toContain(
			'Connect a provider above before you attach a repository.'
		);
	});

	it('shows the GitHub banner once and takes the query off the address', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage('/org/integrations?connected=github');
		await vi.waitFor(() => expect(wrapper.text()).toContain('GitHub is connected.'));
		await vi.waitFor(() =>
			expect(useRouter().currentRoute.value.query.connected).toBeUndefined()
		);
		expect(useRouter().currentRoute.value.path).toBe('/org/integrations');
	});

	it('sends an owner to the provider to connect GitHub', async () => {
		const url = 'https://github.com/apps/drupflare/installations/new?state=s';
		setup({ start: { body: { kind: 'redirect', url } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Connect GitHub')).toBeDefined());
		await button(wrapper, 'Connect GitHub')?.trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(url, { external: true }));
		expect(sentTo('POST', listPath)?.body).toEqual({ provider: 'github' });
	});

	it('asks for a fresh sign-in before connecting, then connects once it is confirmed', async () => {
		const url = 'https://github.com/apps/drupflare/installations/new';
		setup({ start: { body: { kind: 'redirect', url } } });
		signIn(null);
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Connect GitHub')).toBeDefined());
		await button(wrapper, 'Connect GitHub')?.trigger('click');
		await vi.waitFor(() => expect(wrapper.find('[data-step-up-done]').exists()).toBe(true));
		expect(sentTo('POST', listPath)).toBeUndefined();
		signIn(soon());
		await wrapper.find('[data-step-up-done]').trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith(url, { external: true }));
	});

	it('asks for a fresh sign-in when the server says one is needed', async () => {
		setup({
			start: {
				status: 403,
				body: {
					code: 'forbidden',
					message: 'Sign in again.',
					details: { requires: 'step-up' },
					requestId: 'req_5'
				}
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Connect GitHub')).toBeDefined());
		await button(wrapper, 'Connect GitHub')?.trigger('click');
		await vi.waitFor(() => expect(wrapper.find('[data-step-up-done]').exists()).toBe(true));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('shows a connect failure beside the page and sends nobody anywhere', async () => {
		setup({ start: failure('internal', 'The provider is not set up.', 'req_6') });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Connect GitHub')).toBeDefined());
		await button(wrapper, 'Connect GitHub')?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The provider is not set up.'));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('reloads the list when a connect finishes without a redirect', async () => {
		setup({ start: { body: { kind: 'connected', connection: github } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Connect GitHub')).toBeDefined());
		await button(wrapper, 'Connect GitHub')?.trigger('click');
		await vi.waitFor(() =>
			expect(
				calls.filter((call) => call.method === 'GET' && call.path === listPath)
			).toHaveLength(2)
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('confirms a revoke in a dialog, then shows the connection as revoked', async () => {
		setup({ revoke: { body: { ...github, state: 'revoked' } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Revoke')).toBeDefined());
		await button(wrapper, 'Revoke')?.trigger('click');
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		expect(dialog()?.textContent).toContain('Revoke This Connection');
		expect(dialog()?.textContent).toContain('uninstall it in GitHub settings');
		inDialog('Revoke')?.click();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Revoked'));
		expect(sentTo('POST', revokePath('rc_1'))).toBeDefined();
	});

	it('shows a revoke failure beside the page', async () => {
		setup({ revoke: failure('internal', 'Could not revoke.', 'req_7') });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Revoke')).toBeDefined());
		await button(wrapper, 'Revoke')?.trigger('click');
		await vi.waitFor(() => expect(dialog()).not.toBeNull());
		inDialog('Revoke')?.click();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could not revoke.'));
		expect(wrapper.text()).toContain('Active');
	});

	it('lists the repositories attached to the site with the status of the last pull', async () => {
		setup({
			remotes: {
				body: {
					items: [
						remote(),
						remote({ id: 'sr_2', repo: 'acme/theme', lastPullStatus: 'installed' }),
						remote({
							id: 'sr_3',
							repo: 'acme/profile',
							lastPullStatus: null,
							lastPullAt: null
						})
					]
				}
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('acme/theme'));
		expect(wrapper.text()).toContain('Pull Failed');
		expect(wrapper.text()).toContain('Pulled');
		expect(wrapper.text()).toContain('Not Pulled Yet');
		expect(wrapper.text()).toContain('modules/custom/site');
		expect(wrapper.text()).toContain('60 minutes');
	});

	it('shows the reason a pull failed under its remote, and no reason under a pull that worked', async () => {
		const reason = 'The site did not answer. Check that it is online, then pull again.';
		setup({
			remotes: {
				body: {
					items: [
						remote({ lastPullReason: reason }),
						remote({
							id: 'sr_2',
							repo: 'acme/theme',
							lastPullStatus: 'installed',
							lastPullReason: null
						})
					]
				}
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('acme/theme'));
		expect(wrapper.text().split(reason)).toHaveLength(2);
	});

	it('says nothing is attached yet for a site with no remotes', async () => {
		setup({ remotes: { body: { items: [] } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Nothing Attached Yet'));
	});

	it('shows a site the organization does not hold as not found', async () => {
		setup({ remotes: notFound('req_8') });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Site Not Found'));
	});

	it('shows a failed load of the attached repositories with the message', async () => {
		setup({ remotes: failure('internal', 'The remotes broke.', 'req_10') });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Could Not Load Attached Repositories')
		);
		expect(wrapper.text()).toContain('The remotes broke.');
	});

	it('says there are no sites before any repository can be attached', async () => {
		setup({ sites: { body: { items: [], nextCursor: null } } });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Sites Yet'));
		expect(button(wrapper, 'Attach Repository')).toBeUndefined();
	});

	it('tells a developer who cannot connect that only an owner or admin can, and lets them attach', async () => {
		setup({ role: developer });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Attach Repository')).toBeDefined());
		expect(button(wrapper, 'Connect GitHub')?.attributes('disabled')).toBeDefined();
		expect(wrapper.text()).toContain(
			'Only organization owners and admins can connect a provider.'
		);
		expect(button(wrapper, 'Revoke')).toBeUndefined();
	});

	it('tells a viewer that only owners, admins and developers can attach a repository', async () => {
		setup({ role: viewer });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain(
				'Only organization owners, admins and developers can attach a repository.'
			)
		);
		expect(button(wrapper, 'Attach Repository')).toBeUndefined();
	});

	it('names each field that is wrong when the attach form is sent', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Attach Repository')).toBeDefined());
		await button(wrapper, 'Attach Repository')?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Choose a repository.'));
		expect(wrapper.text()).toContain('Enter a branch name.');
		expect(wrapper.text()).toContain('Enter a path such as modules/custom/example.');
		expect(sentTo('POST', remotesPath)).toBeUndefined();
	});

	it('refuses a mount path outside modules, themes or profiles', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Attach Repository')).toBeDefined());
		await fieldByLabel(wrapper, 'Mount Path').setValue('custom/site');
		await button(wrapper, 'Attach Repository')?.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Start the path with modules, themes or profiles.')
		);
		expect(sentTo('POST', remotesPath)).toBeUndefined();
	});

	it('refuses a pull interval under the five minute floor', async () => {
		setup({});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Attach Repository')).toBeDefined());
		await fieldByLabel(wrapper, 'Pull Every (Minutes)').setValue('4');
		await button(wrapper, 'Attach Repository')?.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Enter a whole number of minutes, 5 or more.')
		);
		expect(sentTo('POST', remotesPath)).toBeUndefined();
	});

	it('attaches the picked repository on its default branch and shows it in the list', async () => {
		setup({
			attach: {
				status: 201,
				body: remote({ lastPullStatus: null, lastPullAt: null })
			}
		});
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Attach Repository')).toBeDefined());
		await pickRepo(wrapper);
		await vi.waitFor(() =>
			expect(fieldByLabel(wrapper, 'Branch').element).toHaveProperty('value', 'trunk')
		);
		await fieldByLabel(wrapper, 'Mount Path').setValue('modules/custom/site');
		await button(wrapper, 'Attach Repository')?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Not Pulled Yet'));
		expect(sentTo('POST', remotesPath)?.body).toEqual({
			connectionId: 'rc_1',
			repo: 'acme/site',
			branch: 'trunk',
			mountPath: 'modules/custom/site',
			intervalMinutes: 60
		});
	});

	it('shows the attach failure from the server beside the form', async () => {
		setup({ attach: failure('internal', 'The site is busy.', 'req_11') });
		await useOrgStore().ensure();
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Attach Repository')).toBeDefined());
		await pickRepo(wrapper);
		await fieldByLabel(wrapper, 'Mount Path').setValue('modules/custom/site');
		await button(wrapper, 'Attach Repository')?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The site is busy.'));
	});
});
