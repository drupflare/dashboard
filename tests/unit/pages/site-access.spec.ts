import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import AccessPage from '~/pages/sites/[id]/access.vue';
import { useAccessStore } from '~/stores/access';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const ORG = 'org_personal';
const SITE = 'site_access001';
const base = `/api/v1/orgs/${ORG}/sites/${SITE}`;

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

const PRESETS = [
	{ id: 'members', label: 'Members', available: true, unlockedBy: null },
	{ id: 'grants', label: 'Grants', available: true, unlockedBy: null },
	{ id: 'email-invite', label: 'Email Invite', available: true, unlockedBy: null },
	{ id: 'github-user', label: 'GitHub User', available: true, unlockedBy: null },
	{ id: 'gitlab-user', label: 'GitLab User', available: true, unlockedBy: null },
	{ id: 'github-org', label: 'GitHub Organisation', available: true, unlockedBy: null },
	{ id: 'gitlab-group', label: 'GitLab Group', available: true, unlockedBy: null },
	{ id: 'sso', label: 'Single Sign-On', available: false, unlockedBy: 'Institution Standard' },
	{ id: 'password', label: 'Shared Password', available: true, unlockedBy: null },
	{ id: 'review-link', label: 'Review Link', available: false, unlockedBy: 'Agency' },
	{ id: 'public', label: 'Public', available: true, unlockedBy: null }
];

const STAGING = {
	id: 'env_stage',
	kind: 'staging',
	name: 'Staging',
	host: 'staging.drupflare.app',
	status: 'ready',
	sourceBackupId: null,
	ttlAt: null,
	createdAt: 1
};

const rule = (id: string, environment: string, preset: string, values: string[] = []) => ({
	id,
	environment,
	preset,
	values,
	expiresAt: null,
	createdBy: 'user:usr_1',
	createdAt: 1_767_225_600_000
});

let access: Reply;
let rulesReply: (call: { body: unknown }) => Reply;
let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useAccessStore().$reset();
	useSessionStore().me = {
		id: 'usr_1',
		email: 'owner@example.test',
		displayName: null,
		via: 'session',
		stepUpUntil: null
	} as never;
	access = { body: { rules: [], presets: PRESETS, inviteeLimit: 5 } };
	rulesReply = () => ({ status: 201, body: { rule: rule('rule_new', 'prod', 'members') } });
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
		[`GET ${base}/access`]: () => access,
		[`GET ${base}/environments`]: { body: { items: [STAGING] } },
		[`POST ${base}/access/rules`]: (call) => rulesReply(call),
		[`DELETE ${base}/access/rules/rule_1`]: { status: 204, body: null }
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(AccessPage, { route: `/sites/${SITE}/access` });
	mounted.push(wrapper);
	return wrapper;
}

type Mounted = Awaited<ReturnType<typeof mountPage>>;

function button(wrapper: Mounted, label: string) {
	const found = wrapper.findAll('button').find((item) => item.text().trim() === label);
	if (!found) throw new Error(`no button "${label}"`);
	return found;
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the page');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe('access page', () => {
	it('shows production as public and the rules of each environment', async () => {
		access = {
			body: {
				rules: [rule('rule_1', 'prod', 'email-invite', ['ada@example.test'])],
				presets: PRESETS,
				inviteeLimit: 5
			}
		};
		const wrapper = await mountPage();
		await waitFor(
			() => wrapper.text().includes('ada@example.test') && wrapper.text().includes('Staging')
		);

		expect(wrapper.text()).toContain(
			'Limited. Only the people these rules name can open this site.'
		);
		expect(wrapper.text()).toContain('Staging');
		expect(wrapper.text()).toContain(
			'Private. Nobody can open this environment until a rule is added.'
		);
		expect(wrapper.text()).toContain('Created by a member');
	});

	it('shows production as public when it has no rules', async () => {
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('Public. Anyone can open this site.'));
		expect(wrapper.text()).toContain('No rules here yet.');
	});

	it('greys a preset the plan does not include and names the plan that unlocks it', async () => {
		const wrapper = await mountPage();
		await waitFor(() => wrapper.find('[data-preset="sso"]').exists());

		const sso = wrapper.find('[data-preset="sso"]');
		expect(sso.classes()).toContain('opacity-60');
		expect(sso.text()).toContain('Needs the Institution Standard plan');
		expect(wrapper.find('[data-preset="members"]').text()).toContain('Included');
	});

	it('shows a review link token once and removes it when dismissed', async () => {
		access = {
			body: {
				rules: [],
				presets: PRESETS.map((preset) =>
					preset.id === 'review-link'
						? { ...preset, available: true, unlockedBy: null }
						: preset
				),
				inviteeLimit: 5
			}
		};
		rulesReply = () => ({
			status: 201,
			body: {
				rule: { ...rule('rule_new', 'prod', 'review-link'), expiresAt: 1_900_000_000_000 },
				linkToken: 'tok_once_only'
			}
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.find('select').exists());

		await wrapper.findAll('select')[1]!.setValue('review-link');
		await wrapper.find('form').trigger('submit');
		await waitFor(() => wrapper.text().includes('tok_once_only'));

		expect(wrapper.text()).toContain('Copy this now. It will not be shown again.');
		await button(wrapper, 'Done').trigger('click');
		expect(wrapper.text()).not.toContain('tok_once_only');
	});

	it('shows a shared password once after the rule is added', async () => {
		const wrapper = await mountPage();
		await waitFor(() => wrapper.find('select').exists());

		await wrapper.findAll('select')[1]!.setValue('password');
		await wrapper.find('input[type="password"]').setValue('correct horse');
		await wrapper.find('form').trigger('submit');
		await waitFor(() => wrapper.text().includes('correct horse'));

		expect(wrapper.text()).toContain('Copy this now. It will not be shown again.');
	});

	it('says a saved rule is not active yet and keeps the saved rule in the list', async () => {
		rulesReply = () => ({
			status: 501,
			body: {
				code: 'not_built',
				message: 'Updating who can open a site is not available yet',
				details: {},
				requestId: 'r'
			}
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.find('select').exists());

		await wrapper.findAll('select')[1]!.setValue('public');
		await wrapper.find('form').trigger('submit');
		await waitFor(() => wrapper.text().includes('Saved. Not Active on the Site Yet.'));

		expect(calls.some((call) => call.method === 'GET' && call.path === `${base}/access`)).toBe(
			true
		);
	});

	it('says the change is not active yet when the list says the site has not caught up', async () => {
		access = { body: { rules: [], presets: PRESETS, inviteeLimit: 5, activeOnSite: false } };
		const wrapper = await mountPage();

		await waitFor(() => wrapper.text().includes('Saved. Not Active on the Site Yet.'));
	});

	it('shows no notice when the site has caught up', async () => {
		access = { body: { rules: [], presets: PRESETS, inviteeLimit: 5, activeOnSite: true } };
		const wrapper = await mountPage();
		await waitFor(() => wrapper.find('select').exists());

		expect(wrapper.text()).not.toContain('Saved. Not Active on the Site Yet.');
	});

	it('shows the plan refusal from the server', async () => {
		rulesReply = () => ({
			status: 403,
			body: {
				code: 'forbidden',
				message: 'This access type needs the Site plan',
				details: { unlockedBy: 'Site' },
				requestId: 'r'
			}
		});
		const wrapper = await mountPage();
		await waitFor(() => wrapper.find('select').exists());

		await wrapper.findAll('select')[1]!.setValue('github-user');
		await wrapper.find('textarea').setValue('ada');
		await wrapper.find('form').trigger('submit');
		await waitFor(() => wrapper.text().includes('This access type needs the Site plan'));
	});

	it('asks for a confirmation before a rule is removed', async () => {
		access = {
			body: { rules: [rule('rule_1', 'prod', 'public')], presets: PRESETS, inviteeLimit: 5 }
		};
		const wrapper = await mountPage();
		await waitFor(() => wrapper.find('[data-rule="rule_1"]').exists());

		await button(wrapper, 'Remove').trigger('click');
		expect(wrapper.text()).toContain('lose access the next time the site checks');
		await button(wrapper, 'Remove Rule').trigger('click');
		await waitFor(() => calls.some((call) => call.method === 'DELETE'));
	});

	it('shows the error state when the rules cannot be loaded', async () => {
		access = failure('internal', 'boom', 'req_9');
		const wrapper = await mountPage();
		await waitFor(() => wrapper.text().includes('The access rules could not be loaded.'));
	});
});
