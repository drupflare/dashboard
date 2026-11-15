import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { DOMWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConfigPage from '~/pages/sites/[id]/config.vue';
import { useSessionStore } from '~/stores/session';
import { useSiteConfigStore, type SettingsField, type SettingsView } from '~/stores/site-config';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const ORG = 'org_personal';
const SITE = 'site_1';
const settingsPath = `/api/v1/orgs/${ORG}/sites/${SITE}/settings`;
const soon = () => new Date(Date.now() + 5 * 60 * 1000).toISOString();

const site = {
	id: SITE,
	orgId: ORG,
	name: 'campus-site',
	kind: 'drupal',
	category: 'cms',
	plane: 'managed',
	config: 'managed',
	accountId: null,
	state: 'active',
	ring: 'R1',
	primaryHostname: 'campus-site.drupflare.app',
	hostnames: [],
	admin: { username: 'admin', email: 'owner@example.test', password: 'available' },
	createdAt: '2026-01-01T00:00:00Z',
	updatedAt: '2026-01-01T00:00:00Z'
};

const me = (stepUpUntil: string | null) => ({
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session' as const,
	stepUpUntil
});

function field(over: Partial<SettingsField> = {}): SettingsField {
	return {
		key: 'WARM_INTERVAL_MS',
		label: 'Warm Interval',
		description: null,
		group: 'runtime',
		widget: 'text',
		bounds: null,
		schema: {},
		value: '8000',
		provenance: 'default',
		danger: false,
		editable: true,
		readOnlyReason: null,
		...over
	};
}

function view(over: Partial<SettingsView> = {}): SettingsView {
	return {
		state: 'ready',
		source: 'live',
		stale: false,
		observedAt: '2026-11-13T10:00:00.000Z',
		reason: null,
		etag: '"tag1"',
		groups: [{ id: 'runtime', label: 'Runtime', fields: [field()] }],
		redirects: [],
		...over
	};
}

let settingsReply: () => Reply | Promise<Reply>;
let siteReply: () => Reply;
let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useSiteConfigStore().$reset();
	useSessionStore().me = me(soon());
	siteReply = () => ({ body: site });
	settingsReply = () => ({ body: view() });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me(soon()) },
		[`GET /api/v1/sites/${SITE}`]: () => siteReply(),
		[`GET ${settingsPath}`]: () => settingsReply()
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	vi.restoreAllMocks();
});

async function mountPage() {
	const wrapper = await mountSuspended(ConfigPage, { route: `/sites/${SITE}/config` });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: { findAll: (selector: string) => DOMWrapper<Element>[] }, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text() === text);

describe('settings page', () => {
	it('shows a loading state while the settings are read', async () => {
		settingsReply = () => new Promise<Reply>(() => undefined);
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(calls.some((call) => call.path === settingsPath)).toBe(true));
		expect(wrapper.text()).toContain('Loading Settings');
	});

	it('shows the plain reason when no source answered', async () => {
		settingsReply = () => ({
			body: view({
				state: 'empty',
				source: null,
				reason: 'The site did not answer, and no settings have been stored for it yet.',
				groups: [],
				redirects: []
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Settings Yet'));
		expect(wrapper.text()).toContain('no settings have been stored for it yet');
		expect(wrapper.text()).not.toContain('Effective Configuration');
	});

	it('shows the error state with the reason and a retry when the settings fail to load', async () => {
		settingsReply = () => failure('internal', 'The settings could not be read.', 'req_1');
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load the Settings'));
		expect(wrapper.text()).toContain('The settings could not be read.');
		expect(button(wrapper, 'Try Again')).toBeDefined();
	});

	it('shows a plain not-found state when the site is not ready for its settings', async () => {
		settingsReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {} }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Settings Not Available'));
		expect(wrapper.text()).not.toContain('Loading Settings');
	});

	it('shows the populated page with a plan that is read-only and says why', async () => {
		settingsReply = () => ({
			body: view({
				groups: [
					{
						id: 'runtime',
						label: 'Runtime',
						fields: [
							field({
								key: 'PLAN',
								label: 'Plan',
								value: 'paid',
								provenance: 'var',
								editable: false,
								readOnlyReason:
									'The platform sets the plan, so it cannot change here.'
							})
						]
					}
				]
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Effective Configuration'));
		expect(wrapper.text()).toContain('Read Only');
		expect(wrapper.text()).toContain('The platform sets the plan, so it cannot change here.');
		expect(wrapper.text()).toContain('Deploy Setting');
		expect(wrapper.text()).toContain('Wrangler Configuration');
	});

	it('leaves out a group the principal cannot read', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('#group-runtime').exists()).toBe(true));
		expect(wrapper.find('#group-security').exists()).toBe(false);
		expect(wrapper.text()).not.toContain('Security');
	});

	it('shows the redirect table when the document carries redirects', async () => {
		settingsReply = () => ({
			body: view({ redirects: [{ from: '/old-page', to: '/new-page' }] })
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('#redirects-heading').exists()).toBe(true));
		const table = wrapper.get('[aria-labelledby="redirects-heading"] table');
		expect(table.text()).toContain('/old-page');
		expect(table.text()).toContain('/new-page');
	});

	it('hides the redirect table when the document carries none', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('#group-runtime').exists()).toBe(true));
		expect(wrapper.find('#redirects-heading').exists()).toBe(false);
	});

	it('downloads the Wrangler view as wrangler.jsonc with the deploy variables', async () => {
		settingsReply = () => ({
			body: view({
				groups: [
					{
						id: 'runtime',
						label: 'Runtime',
						fields: [
							field({ key: 'PAGE_KV_TTL', value: 86400, provenance: 'var' }),
							field({ key: 'WARM_INTERVAL_MS', value: '9000', provenance: 'kv' })
						]
					}
				]
			})
		});
		const createObjectURL = vi.fn((_blob: Blob) => 'blob:wrangler');
		const revokeObjectURL = vi.fn();
		URL.createObjectURL = createObjectURL;
		URL.revokeObjectURL = revokeObjectURL;
		let downloaded: string | null = null;
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
			this: HTMLAnchorElement
		) {
			downloaded = this.download;
		});

		const wrapper = await mountPage();
		await vi.waitFor(() => expect(button(wrapper, 'Download wrangler.jsonc')).toBeDefined());
		await button(wrapper, 'Download wrangler.jsonc')!.trigger('click');

		expect(downloaded).toBe('wrangler.jsonc');
		expect(createObjectURL).toHaveBeenCalledOnce();
		const blob = createObjectURL.mock.calls[0]![0] as Blob;
		const text = await blob.text();
		expect(JSON.parse(text)).toEqual({ vars: { PAGE_KV_TTL: 86400 } });
		expect(text).not.toContain('WARM_INTERVAL_MS');
	});
});
