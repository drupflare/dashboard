import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SitePage from '~/pages/sites/[id]/index.vue';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi, type Reply } from '../stores/store-support';

const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};

function site(kind: string) {
	return {
		id: 'site_1',
		orgId: 'org_personal',
		name: 'quiet-oak-harbor',
		kind,
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		accountId: null,
		state: 'active',
		ring: 'R1',
		primaryHostname: 'quiet-oak-harbor.drupflare.app',
		hostnames: [],
		admin: { username: 'admin', email: 'owner@example.test', password: 'available' },
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

let cleanup: () => void = () => undefined;
let siteReply: () => Reply | Promise<Reply>;
let opsReply: () => Reply | Promise<Reply>;
let stateReply: () => Reply;
let cutoverReply: () => Reply;
let domainReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	siteReply = () => ({ body: site('drupal') });
	stateReply = () => ({ body: { kind: 'admin-password', state: 'revealed' } });
	cutoverReply = () => ({
		body: {
			ready: false,
			available: false,
			policies: [],
			observationOffsetsMs: [],
			cutover: null
		}
	});
	domainReply = () => ({
		body: { ready: true, enabled: true, attached: [], attach: null }
	});
	opsReply = () => ({
		body: {
			items: [
				{
					id: 'op_1',
					type: 'site.create',
					status: 'succeeded',
					updatedAt: '2026-01-01T00:00:00Z'
				}
			],
			nextCursor: null
		}
	});
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/sites/site_1': () => siteReply(),
		'GET /api/v1/sites/site_1/operations': () => opsReply(),
		'GET /api/v1/orgs/org_personal/sites/site_1/cutover': () => cutoverReply(),
		'GET /api/v1/orgs/org_personal/sites/site_1/domain': () => domainReply(),
		'GET /api/v1/orgs/org_personal/sites/site_1/first-run-secret': () => stateReply()
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	document.body.replaceChildren();
});

async function mountPage() {
	const wrapper = await mountSuspended(SitePage, { route: '/sites/site_1' });
	mounted.push(wrapper);
	return wrapper;
}

describe('site page', () => {
	it('shows the header with name, address and state, and the recent operations', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.find('h1').text()).toBe('quiet-oak-harbor'));
		expect(wrapper.text()).toContain('quiet-oak-harbor.drupflare.app');
		expect(wrapper.text()).toContain('Active');
		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(1));
		expect(wrapper.text()).toContain('Create');
		expect(wrapper.text()).not.toContain('site.create');
		expect(wrapper.text()).toContain('Succeeded');
	});

	it('shows the plain reason on a failed activity row and a generic label for an unknown type', async () => {
		opsReply = () => ({
			body: {
				items: [
					{
						id: 'op_2',
						type: 'site.upgrade',
						status: 'rolled-back',
						reason: 'Stopped while checking that the site answers.',
						updatedAt: '2026-01-01T00:00:00Z'
					},
					{
						id: 'op_3',
						type: 'repair.run',
						status: 'succeeded',
						reason: null,
						updatedAt: '2026-01-01T00:00:00Z'
					}
				],
				nextCursor: null
			}
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(2));
		const [failed, other] = wrapper.findAll('li');
		expect(failed?.text()).toContain('Update');
		expect(failed?.text()).toContain('Stopped while checking that the site answers.');
		expect(other?.text()).toContain('Change');
		expect(other?.text()).not.toContain('repair.run');
		expect(other?.text()).not.toContain('Stopped');
	});

	it('links Open Admin for a Drupal site', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Open Admin'));
		const link = wrapper.find('a[href="https://quiet-oak-harbor.drupflare.app/user/login"]');
		expect(link.exists()).toBe(true);
	});

	describe('the Custom Domain button', () => {
		it('links the domain page for a member who can read it on a site that can take one', async () => {
			const wrapper = await mountPage();

			await vi.waitFor(() => expect(wrapper.text()).toContain('Custom Domain'));
			expect(wrapper.find('a[href="/sites/site_1/domain"]').exists()).toBe(true);
			expect(wrapper.find('[data-test="domains-off"]').exists()).toBe(false);
		});

		it('turns the button off with a plain sentence while the platform has custom domains off', async () => {
			domainReply = () => ({
				body: { ready: true, enabled: false, attached: [], attach: null }
			});
			const wrapper = await mountPage();

			await vi.waitFor(() =>
				expect(wrapper.find('[data-test="domains-off"]').exists()).toBe(true)
			);
			expect(wrapper.find('[data-test="domains-off"]').text()).toBe(
				'Custom domains are not turned on for this Drupflare account yet.'
			);
			expect(wrapper.find('a[href$="/domain"]').exists()).toBe(false);
			const button = wrapper
				.findAll('button')
				.find((item) => item.text() === 'Custom Domain');
			expect(button?.attributes('disabled')).toBeDefined();
		});

		it.each(['suspended', 'tombstoned'])(
			'is absent for a %s site, which the server says cannot take a domain',
			async (state) => {
				siteReply = () => ({ body: { ...site('drupal'), state } });
				domainReply = () => ({
					body: { ready: false, enabled: true, attached: [], attach: null }
				});
				const wrapper = await mountPage();

				await vi.waitFor(() =>
					expect(calls.some((call) => call.path.endsWith('/domain'))).toBe(true)
				);
				await vi.waitFor(() => expect(wrapper.find('h1').exists()).toBe(true));
				expect(wrapper.text()).not.toContain('Custom Domain');
				expect(wrapper.find('a[href$="/domain"]').exists()).toBe(false);
			}
		);

		it('is absent for a member the server refuses the domain read, such as a developer', async () => {
			domainReply = () => ({
				status: 403,
				body: { code: 'forbidden', message: 'Not allowed' }
			});
			const wrapper = await mountPage();

			await vi.waitFor(() => expect(wrapper.text()).toContain('Open Admin'));
			await vi.waitFor(() =>
				expect(calls.some((call) => call.path.endsWith('/domain'))).toBe(true)
			);
			expect(wrapper.text()).not.toContain('Custom Domain');
			expect(wrapper.text()).not.toContain('not turned on');
		});

		it('is absent when the domain read fails', async () => {
			domainReply = () => ({ status: 500, body: { code: 'internal', message: 'down' } });
			const wrapper = await mountPage();

			await vi.waitFor(() => expect(wrapper.text()).toContain('Open Admin'));
			expect(wrapper.text()).not.toContain('Custom Domain');
		});
	});

	it('hides the cutover link while the server says a cutover cannot run', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Open Admin'));
		await vi.waitFor(() =>
			expect(calls.some((call) => call.path.endsWith('/cutover'))).toBe(true)
		);
		expect(wrapper.text()).not.toContain('Cut Over');
		expect(wrapper.find('a[href$="/cutover"]').exists()).toBe(false);
	});

	it('links the cutover page once a cutover can run', async () => {
		cutoverReply = () => ({
			body: {
				ready: true,
				available: true,
				policies: [],
				observationOffsetsMs: [],
				cutover: null
			}
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Cut Over'));
		expect(wrapper.find('a[href$="/cutover"]').exists()).toBe(true);
	});

	it('hides the cutover link when the cutover read fails', async () => {
		cutoverReply = () => ({ status: 500, body: { code: 'internal', message: 'down' } });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Open Admin'));
		expect(wrapper.text()).not.toContain('Cut Over');
	});

	it('does not show Open Admin for a kind without a known admin path', async () => {
		siteReply = () => ({ body: site('smoke') });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.find('h1').exists()).toBe(true));
		expect(wrapper.text()).not.toContain('Open Admin');
		expect(wrapper.text()).not.toContain('Admin Sign-In');
	});

	it('shows Admin Sign-In right after Open Admin, with the recorded username and email', async () => {
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('shown once and is not stored'));
		const text = wrapper.text();
		expect(text.indexOf('Open Admin')).toBeLessThan(text.indexOf('Admin Sign-In'));
		expect(text).toContain('owner@example.test');
		expect(wrapper.text()).toContain('Open Sign-In Page');
	});

	it('shows skeletons shaped like the page until the site and its operations arrive', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		siteReply = async () => {
			await gate;
			return { body: site('drupal') };
		};
		opsReply = async () => {
			await gate;
			return { body: { items: [], nextCursor: null } };
		};
		const wrapper = await mountPage();

		expect(wrapper.text()).toContain('Loading the site');
		expect(wrapper.text()).toContain('Loading activity');
		expect(wrapper.findAll('.animate-pulse').length).toBeGreaterThan(8);
		expect(wrapper.text()).not.toContain('Loading the site...');

		release();
		await vi.waitFor(() => expect(wrapper.find('h1').text()).toBe('quiet-oak-harbor'));
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Activity Yet'));
		expect(wrapper.text()).not.toContain('Loading activity');
		expect(wrapper.text()).not.toContain('Operation');
	});

	it('shows the server message when the site cannot be loaded', async () => {
		siteReply = () => ({
			status: 500,
			body: {
				code: 'internal',
				message: 'Something went wrong on our side. Try again.',
				details: {},
				requestId: 'req_500'
			}
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load the Site'));
		expect(wrapper.text()).toContain('Something went wrong on our side. Try again.');
		expect(wrapper.text()).toContain('req_500');
	});

	it('shows Site Not Found for a site the person cannot read', async () => {
		siteReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_404' }
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Site Not Found'));
	});
});

describe('site page retry', () => {
	const failedRows = () => ({
		body: {
			items: [
				{
					id: 'op_2',
					type: 'site.upgrade',
					status: 'failed',
					reason: 'Stopped while checking that the site answers.',
					updatedAt: '2026-01-01T00:00:00Z'
				},
				{
					id: 'op_3',
					type: 'site.delete',
					status: 'failed',
					reason: 'Stopped while removing the site address.',
					updatedAt: '2026-01-01T00:00:00Z'
				},
				{
					id: 'op_4',
					type: 'backup.create',
					status: 'rolled-back',
					reason: null,
					updatedAt: '2026-01-01T00:00:00Z'
				}
			],
			nextCursor: null
		}
	});

	function registerWith(extra: Record<string, () => Reply>) {
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'GET /api/v1/sites/site_1': () => siteReply(),
			'GET /api/v1/sites/site_1/operations': () => failedRows(),
			'GET /api/v1/orgs/org_personal/sites/site_1/first-run-secret': () => stateReply(),
			...extra
		});
	}

	it('offers Try Again on failed rows that can be retried, and opens the progress page of the retry', async () => {
		registerWith({
			'POST /api/v1/orgs/org_personal/operations/op_2/retry': () => ({
				status: 202,
				body: { id: 'op_9', type: 'site.upgrade', status: 'planned', targetIds: ['site_1'] }
			})
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(3));
		const [upgrade, deleted, backup] = wrapper.findAll('li');
		expect(upgrade?.findAll('button').map((b) => b.text().trim())).toEqual(['Try Again']);
		expect(deleted?.findAll('button')).toHaveLength(0);
		expect(backup?.findAll('button').map((b) => b.text().trim())).toEqual(['Try Again']);

		await upgrade?.findAll('button')[0]?.trigger('click');
		await vi.waitFor(() =>
			expect(useRouter().currentRoute.value.path).toBe('/new/progress/op_9')
		);
	});

	it('shows the plain reason beside the list when the retry is refused', async () => {
		registerWith({
			'POST /api/v1/orgs/org_personal/operations/op_2/retry': () => ({
				status: 422,
				body: {
					code: 'unprocessable',
					message: 'This site is not live, so the work cannot be retried',
					details: { reason: 'site_not_live' },
					requestId: 'req_live'
				}
			})
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(3));
		await wrapper.findAll('li')[0]?.findAll('button')[0]?.trigger('click');

		await vi.waitFor(() =>
			expect(wrapper.findAll('[role="alert"]').map((a) => a.text())).toContain(
				'The site is not live, so this cannot be tried again.'
			)
		);
	});
});

describe('adopting a self-managed site', () => {
	const selfManaged = () => ({ ...site('drupal'), plane: 'self-managed' });

	it('shows Adopt only for an active self-managed site', async () => {
		siteReply = () => ({ body: selfManaged() });
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.findAll('button').some((button) => button.text() === 'Adopt')).toBe(true)
		);
	});

	it('does not show Adopt for a managed site', async () => {
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(1));
		expect(wrapper.findAll('button').some((button) => button.text() === 'Adopt')).toBe(false);
	});

	it('does not show Adopt for a self-managed site that is no longer active', async () => {
		siteReply = () => ({ body: { ...selfManaged(), state: 'tombstoned' } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(1));
		expect(wrapper.findAll('button').some((button) => button.text() === 'Adopt')).toBe(false);
	});

	it('waits for the activity list before it offers Adopt', async () => {
		siteReply = () => ({ body: selfManaged() });
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const original = opsReply;
		opsReply = async () => {
			await gate;
			return original();
		};
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.find('h1').exists()).toBe(true));
		expect(wrapper.findAll('button').some((button) => button.text() === 'Adopt')).toBe(false);
		release();
		await vi.waitFor(() =>
			expect(wrapper.findAll('button').some((button) => button.text() === 'Adopt')).toBe(true)
		);
	});

	it('shows a link to the managed copy instead of Adopt once an adoption succeeded', async () => {
		siteReply = () => ({ body: selfManaged() });
		opsReply = () => ({
			body: {
				items: [
					{
						id: 'op_9',
						type: 'site.adopt',
						status: 'succeeded',
						targetIds: ['site_9', 'site_1'],
						reason: null,
						updatedAt: '2026-01-01T00:00:00Z'
					}
				],
				nextCursor: null
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('This site was adopted.'));
		expect(wrapper.find('a[href="/sites/site_9"]').text()).toBe('Open the managed copy');
		expect(wrapper.findAll('button').some((button) => button.text() === 'Adopt')).toBe(false);
	});

	it('still offers Adopt when the only adoption failed', async () => {
		siteReply = () => ({ body: selfManaged() });
		opsReply = () => ({
			body: {
				items: [
					{
						id: 'op_8',
						type: 'site.adopt',
						status: 'rolled-back',
						targetIds: ['site_8', 'site_1'],
						reason: 'Stopped while copying your site database.',
						updatedAt: '2026-01-01T00:00:00Z'
					}
				],
				nextCursor: null
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.findAll('button').some((button) => button.text() === 'Adopt')).toBe(true)
		);
		expect(wrapper.text()).toContain('Stopped while copying your site database.');
	});
});

describe('a site on a box', () => {
	const found = (patch: Record<string, unknown> = {}) => ({
		...site('drupal'),
		plane: 'self-hosted',
		config: 'canonical',
		box: { found: true, missingSince: null },
		...patch
	});
	const hasButton = (wrapper: Awaited<ReturnType<typeof mountPage>>, label: string) =>
		wrapper.findAll('button').some((button) => button.text() === label);

	it('shows the badge and the note for a found site, with only what the box can answer', async () => {
		siteReply = () => ({ body: found() });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Found on Your Box'));
		expect(wrapper.find('[data-test="found-note"]').exists()).toBe(true);
		expect(wrapper.text()).toContain('Open Admin');
		expect(wrapper.text()).toContain('Site Health');
		expect(wrapper.text()).toContain('Readiness');
		expect(wrapper.text()).not.toContain('Backups');
		expect(hasButton(wrapper, 'Update')).toBe(false);
		expect(wrapper.text()).not.toContain('Update Available');
	});

	it('leaves out health and readiness for a found site the box kept the address of back', async () => {
		siteReply = () => ({
			body: found({ name: 'Site 1 on campus-box', primaryHostname: null })
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.find('[data-test="name-note"]').exists()).toBe(true));
		expect(wrapper.text()).not.toContain('Site Health');
		expect(wrapper.text()).not.toContain('Readiness');
		expect(wrapper.text()).not.toContain('Open Admin');
		expect(wrapper.text()).toContain('Not Set');
	});

	it('says a site is not on the box and keeps the usual panels for a site the dashboard made', async () => {
		siteReply = () => ({
			body: found({ box: { found: false, missingSince: '2026-02-01T00:00:00Z' } })
		});
		const wrapper = await mountPage();

		await vi.waitFor(() =>
			expect(wrapper.find('[data-test="missing-note"]').exists()).toBe(true)
		);
		expect(wrapper.text()).toContain('Not on the Box');
		expect(wrapper.text()).not.toContain('Found on Your Box');
		expect(wrapper.find('a[href="/planes"]').text()).toBe('Check the Box');
		expect(wrapper.text()).toContain('Backups');
	});

	it('renames a found site and shows the new name in the header', async () => {
		siteReply = () => ({ body: found({ name: 'Site 1 on campus-box' }) });
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'GET /api/v1/sites/site_1': () => siteReply(),
			'GET /api/v1/sites/site_1/operations': () => opsReply(),
			'POST /api/v1/orgs/org_personal/sites/site_1/rename': () => ({
				body: found({ name: 'Library Portal' })
			})
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(hasButton(wrapper, 'Rename Site')).toBe(true));

		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Rename Site')!
			.trigger('click');
		await wrapper.find('#site-rename').setValue('Library Portal');
		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() => expect(wrapper.find('h1').text()).toBe('Library Portal'));
		expect(calls.find((call) => call.path.endsWith('/rename'))?.body).toEqual({
			name: 'Library Portal'
		});
	});

	it('offers no rename for a site the dashboard made', async () => {
		siteReply = () => ({ body: found({ box: { found: false, missingSince: null } }) });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.find('h1').exists()).toBe(true));
		expect(hasButton(wrapper, 'Rename Site')).toBe(false);
		expect(wrapper.find('[data-test="box-notice"]').exists()).toBe(false);
	});

	it('words the delete dialog for the case the site is in', async () => {
		siteReply = () => ({ body: found() });
		const wrapper = await mountSuspended(SitePage, {
			route: '/sites/site_1',
			attachTo: document.body
		});
		mounted.push(wrapper);
		await vi.waitFor(() => expect(hasButton(wrapper, 'Delete Site')).toBe(true));
		await wrapper
			.findAll('button')
			.find((button) => button.text() === 'Delete Site')!
			.trigger('click');
		await vi.waitFor(() =>
			expect(document.querySelector('[data-test="box-delete"]')?.textContent).toContain(
				'stays on your box and keeps serving'
			)
		);
	});
});
