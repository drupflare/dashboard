import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Update from '~/components/site/Update.vue';
import { useSessionStore } from '~/stores/session';
import { useSitesStore, type SiteSummary } from '~/stores/sites';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_a';
const SITE = 'site_1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sitesPath = `GET /api/v1/orgs/${ORG}/sites`;
const upgradePath = `POST /api/v1/orgs/${ORG}/sites/${SITE}/upgrade`;

function site(release: SiteSummary['release']): SiteSummary {
	return {
		id: SITE,
		orgId: ORG,
		name: 'Quiet Otter',
		kind: 'drupal',
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		accountId: null,
		state: 'active',
		ring: 'R0',
		primaryHostname: 'quiet-otter.drupflare.app',
		hostnames: ['quiet-otter.drupflare.app'],
		admin: { username: null, email: null, password: 'unknown' },
		...(release === undefined ? {} : { release }),
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

const list = (release: SiteSummary['release']) => ({
	body: { items: [site(release)], nextCursor: null }
});

const failure = (status: number, code: string, message: string) => ({
	status,
	body: { code, message, details: {}, requestId: 'req_test' }
});

const cleanups: (() => void)[] = [];
const mounted: { unmount: () => void }[] = [];

const register = (routes: Parameters<typeof registerApi>[0]) => {
	cleanups.push(registerApi(routes));
};

async function mountUpdate() {
	const wrapper = await mountSuspended(Update, { props: { orgId: ORG, siteId: SITE } });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: { findAll: (selector: string) => any[] }, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text().trim() === text);

const dialogSubmit = () => document.querySelector<HTMLButtonElement>('form button[type="submit"]');

async function openDialog(wrapper: Awaited<ReturnType<typeof mountUpdate>>) {
	await vi.waitFor(() => expect(button(wrapper, 'Update')).toBeTruthy());
	await button(wrapper, 'Update')!.trigger('click');
	await vi.waitFor(() => expect(dialogSubmit()).not.toBeNull());
}

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useSitesStore().$reset();
	navigate.mockReset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanups.splice(0).forEach((cleanup) => cleanup());
});

describe('the release of a site', () => {
	it('shows Up to Date with the release id when the site runs the available release', async () => {
		register({ [sitesPath]: list({ current: 'v1.0.5', available: 'v1.0.5' }) });
		const wrapper = await mountUpdate();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Up to Date'));
		expect(wrapper.text()).toContain('v1.0.5');
		expect(button(wrapper, 'Update')).toBeUndefined();
	});

	it('shows Update Available with both releases and an Update button', async () => {
		register({ [sitesPath]: list({ current: 'v1.0.4', available: 'v1.0.5' }) });
		const wrapper = await mountUpdate();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Update Available'));
		expect(wrapper.text()).toContain('v1.0.4');
		expect(wrapper.text()).toContain('v1.0.5');
		expect(button(wrapper, 'Update')).toBeTruthy();
	});

	it('offers the update to a site with no recorded release', async () => {
		register({ [sitesPath]: list({ current: null, available: 'v1.0.5' }) });
		const wrapper = await mountUpdate();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Update Available'));
		expect(wrapper.text()).toContain('unrecorded');
		expect(button(wrapper, 'Update')).toBeTruthy();
	});

	it('renders nothing when no release is available', async () => {
		register({ [sitesPath]: list({ current: 'v1.0.4', available: null }) });
		const wrapper = await mountUpdate();
		await vi.waitFor(() => expect(calls.some((call) => call.method === 'GET')).toBe(true));
		await vi.waitFor(() => expect(useSitesStore().byId.has(SITE)).toBe(true));
		expect(wrapper.text()).toBe('');
		expect(wrapper.find('button').exists()).toBe(false);
	});

	it('renders nothing for a site read that carries no release', async () => {
		register({ [sitesPath]: list(undefined) });
		const wrapper = await mountUpdate();
		await vi.waitFor(() => expect(useSitesStore().byId.has(SITE)).toBe(true));
		expect(wrapper.text()).toBe('');
	});
});

describe('starting an update', () => {
	const available = { current: 'v1.0.4', available: 'v1.0.5' };

	it('explains what happens in plain words before it asks', async () => {
		register({ [sitesPath]: list(available) });
		const wrapper = await mountUpdate();
		await openDialog(wrapper);
		const text = document.body.textContent ?? '';
		expect(text).toContain('keeps serving');
		expect(text).toContain('several minutes');
		expect(text).toContain('returns to its old release on its own');
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(0);
	});

	it('posts once with an Idempotency-Key and leads to the progress screen', async () => {
		register({
			[sitesPath]: list(available),
			[upgradePath]: { status: 202, body: { id: 'op_up', type: 'site.upgrade' } }
		});
		const wrapper = await mountUpdate();
		await openDialog(wrapper);
		dialogSubmit()!
			.closest('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }));
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_up'));
		const posts = calls.filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe(`/api/v1/orgs/${ORG}/sites/${SITE}/upgrade`);
		expect(posts[0]?.headers['idempotency-key']).toMatch(UUID);
	});

	it('sends one request when the form is submitted twice while the first is pending', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		register({
			[sitesPath]: list(available),
			[upgradePath]: async () => {
				await gate;
				return { status: 202, body: { id: 'op_up', type: 'site.upgrade' } };
			}
		});
		const wrapper = await mountUpdate();
		await openDialog(wrapper);
		const form = dialogSubmit()!.closest('form')!;
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		release();
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it.each([
		[409, 'conflict', 'Another change to this site is still running'],
		[409, 'conflict', 'This site already runs the current release'],
		[422, 'unprocessable', 'This site is not live, so it cannot be updated']
	])('shows the message of a %i and stays on the page', async (status, code, message) => {
		register({
			[sitesPath]: list(available),
			[upgradePath]: failure(status, code, message)
		});
		const wrapper = await mountUpdate();
		await openDialog(wrapper);
		dialogSubmit()!
			.closest('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }));
		await vi.waitFor(() =>
			expect(document.querySelector('[role="alert"]')?.textContent).toContain(message)
		);
		expect(navigate).not.toHaveBeenCalled();
	});

	it('asks again with a new key after a refusal', async () => {
		let refuse = true;
		register({
			[sitesPath]: list(available),
			[upgradePath]: () =>
				refuse
					? failure(409, 'conflict', 'Another change to this site is still running')
					: { status: 202, body: { id: 'op_up', type: 'site.upgrade' } }
		});
		const wrapper = await mountUpdate();
		await openDialog(wrapper);
		const form = dialogSubmit()!.closest('form')!;
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
		refuse = false;
		form.dispatchEvent(new Event('submit', { cancelable: true }));
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_up'));
		const posts = calls.filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(2);
	});
});

describe('the store action behind it', () => {
	it('posts with the key, drops the cached list and returns the operation', async () => {
		register({
			[sitesPath]: list({ current: 'v1.0.4', available: 'v1.0.5' }),
			[upgradePath]: { status: 202, body: { id: 'op_up', type: 'site.upgrade' } }
		});
		const sites = useSitesStore();
		await sites.load(ORG);
		expect(sites.lists.get(ORG)?.status).toBe('ready');
		const operation = await sites.upgrade(ORG, SITE, 'key-up-1');
		expect(operation).toMatchObject({ id: 'op_up' });
		expect(calls.at(-1)?.headers['idempotency-key']).toBe('key-up-1');
		expect(sites.lists.has(ORG)).toBe(false);
	});

	it('throws the API error and clears the session on a 401', async () => {
		useSessionStore().me = {
			id: 'usr_1',
			email: 'owner@example.test',
			displayName: null,
			via: 'session',
			stepUpUntil: null
		};
		register({
			[upgradePath]: failure(401, 'unauthenticated', 'Sign in')
		});
		await expect(useSitesStore().upgrade(ORG, SITE, 'key-up-2')).rejects.toMatchObject({
			status: 401
		});
		expect(useSessionStore().me).toBeNull();
	});
});
