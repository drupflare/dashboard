import { useNuxtApp } from '#app';
import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProgressPage from '~/pages/new/progress/[op].vue';
import { useOperationsStore } from '~/stores/operations';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Reply
} from '../stores/store-support';

const personal = { id: 'org_personal', name: 'Personal', personal: true, role: 'owner' };
const me = {
	id: 'usr_1',
	email: 'owner@example.test',
	displayName: null,
	via: 'session',
	stepUpUntil: null
};
const opKey = `GET /api/v1/orgs/${personal.id}/operations/op_1`;
const siteKey = 'GET /api/v1/sites/site_1';
const secretKey = `POST /api/v1/orgs/${personal.id}/sites/site_1/first-run-secret`;
const password = 'Pw-Test-7d3f-admin';

const site = {
	id: 'site_1',
	orgId: personal.id,
	name: 'quiet-oak-harbor',
	kind: 'drupal',
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

function step(id: string, name: string, state: string, error: string | null = null) {
	return {
		id,
		name,
		state,
		attempt: 1,
		startedAt: null,
		finishedAt: null,
		error
	};
}

function operation(status: string, steps: ReturnType<typeof step>[], type = 'site.create') {
	return {
		id: 'op_1',
		orgId: personal.id,
		type,
		status,
		targetIds: ['site_1'],
		steps,
		finalObservation: null,
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

let cleanup: () => void = () => undefined;
let opReply: () => Reply | Promise<Reply>;
let secretReply: () => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useOperationsStore().reset();
	opReply = () => ({
		body: operation('running', [step('a', 'Reserve quiet-oak-harbor', 'succeeded')])
	});
	secretReply = () => ({ body: { kind: 'admin-password', value: password } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[opKey]: () => opReply(),
		[siteKey]: { body: site },
		[secretKey]: () => secretReply()
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

async function mountPage() {
	const wrapper = await mountSuspended(ProgressPage, { route: '/new/progress/op_1' });
	mounted.push(wrapper);
	return wrapper;
}

function revealButton(wrapper: {
	findAll(selector: string): { text(): string; trigger(e: string): Promise<unknown> }[];
}) {
	return wrapper.findAll('button').find((b) => b.text().trim() === 'Reveal Password');
}

describe('create progress', () => {
	it('shows a skeleton shaped like the timeline until the activity arrives', async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		opReply = async () => {
			await gate;
			return { body: operation('running', [step('verify', 'Probe the site', 'running')]) };
		};
		const wrapper = await mountPage();

		const loading = wrapper.find('[role="status"]');
		expect(loading.text()).toBe('Loading the activity');
		expect(loading.findAll('.animate-pulse').length).toBeGreaterThan(5);
		expect(wrapper.text()).not.toContain('Loading the activity...');

		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Checking that the site answers'));
		expect(wrapper.text()).not.toContain('Probe the site');
		expect(wrapper.text()).not.toContain('Loading the activity');
	});

	it('renders every step state with an icon and text, and names the running step in plain words', async () => {
		opReply = () => ({
			body: operation('running', [
				step('lease', 'Take the site writer lease', 'succeeded'),
				step('assets', 'Upload static assets', 'running'),
				step('upload-script', 'Upload the script', 'pending'),
				step('verify', 'Probe the site', 'skipped'),
				step('route', 'Route quiet-oak-harbor.drupflare.app', 'failed')
			])
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.findAll('li')).toHaveLength(5));
		const text = wrapper.text();
		for (const label of ['Succeeded', 'Running', 'Pending', 'Skipped', 'Failed']) {
			expect(text).toContain(label);
		}
		expect(wrapper.html()).toContain('loader-circle');
		expect(text).toContain('Now: Uploading static files');
		expect(text).toContain('Locking the site for this change');
		expect(text).toContain('Connecting the site address');
		expect(text).not.toContain('Take the site writer lease');
		expect(text).not.toContain('quiet-oak-harbor.drupflare.app');
	});

	it('names an unknown step in a generic phrase and never shows its raw name', async () => {
		opReply = () => ({
			body: operation('running', [step('made-up', 'Reserve the widget table', 'running')])
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Now: Working on this step'));
		expect(wrapper.text()).not.toContain('widget');
	});

	it('reveals the admin password once, then shows Already Shown on a second reveal', async () => {
		opReply = () => ({
			body: operation('succeeded', [step('a', 'Mark the site active', 'succeeded')])
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('quiet-oak-harbor.drupflare.app'));
		expect(wrapper.text()).not.toContain(password);
		expect(wrapper.text()).toContain('Open Admin');

		await revealButton(wrapper)?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain(password));
		expect(wrapper.text()).toContain('will not be shown again');

		wrapper.unmount();
		secretReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_2' }
		});
		const again = await mountPage();
		await vi.waitFor(() => expect(revealButton(again)).toBeDefined());
		await revealButton(again)?.trigger('click');

		await vi.waitFor(() => expect(again.text()).toContain('Already Shown'));
		expect(again.text()).not.toContain(password);
		expect(again.find('[role="alert"]').exists()).toBe(false);
	});

	it('shows the admin username above the password', async () => {
		opReply = () => ({
			body: operation('succeeded', [step('a', 'Mark the site active', 'succeeded')])
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Username'));
		const text = wrapper.text();
		expect(text).toContain('admin');
		expect(text.indexOf('Username')).toBeLessThan(text.indexOf('Admin Password'));
	});

	it('leaves the username line out for a site that did not record one', async () => {
		opReply = () => ({
			body: operation('succeeded', [step('a', 'Mark the site active', 'succeeded')])
		});
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
			[opKey]: () => opReply(),
			[siteKey]: {
				body: { ...site, admin: { username: null, email: null, password: 'unknown' } }
			},
			[secretKey]: () => secretReply()
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Admin Password'));
		expect(wrapper.text()).not.toContain('Username');
	});

	it('keeps the password out of every store and out of the DOM after leaving', async () => {
		opReply = () => ({
			body: operation('succeeded', [step('a', 'Mark the site active', 'succeeded')])
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(revealButton(wrapper)).toBeDefined());

		const pinia = useNuxtApp().$pinia;
		expect(JSON.stringify(pinia.state.value)).not.toContain(password);

		await revealButton(wrapper)?.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain(password));
		expect(JSON.stringify(pinia.state.value)).not.toContain(password);
		expect(sessionStorage.getItem('drupflare.onboarding') ?? '').not.toContain(password);

		wrapper.unmount();
		expect(document.body.innerHTML).not.toContain(password);
	});

	it('shows the failed step in plain words, the plain reason and the rollback', async () => {
		opReply = () => ({
			body: {
				...operation('rolled-back', [
					step('reserve-name', 'Reserve quiet-oak-harbor', 'succeeded'),
					step(
						'assets',
						'Upload static assets',
						'failed',
						'assets: name_taken: raw 10000'
					)
				]),
				finalObservation: { at: '2026-01-01T00:00:00Z', summary: 'assets: raw summary' }
			}
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Create the Site'));
		expect(wrapper.text()).toContain('Stopped while uploading static files.');
		expect(wrapper.text()).toContain('Failed step: Uploading static files');
		expect(wrapper.text()).toContain('rolled back');
		expect(wrapper.text()).not.toContain('name_taken');
		expect(wrapper.text()).not.toContain('raw summary');
		expect(wrapper.text()).not.toContain('assets:');
	});

	it('shows the operation as not found without an error banner', async () => {
		opReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_3' }
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Activity Not Found'));
	});

	it('reports a failed activity read with its request id', async () => {
		opReply = () => failure('internal', 'Failed', 'req_read');
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load the Activity'));
		expect(wrapper.text()).toContain('req_read');
	});
});

describe('progress for each operation type', () => {
	const ended = [step('lease', 'Take the site writer lease', 'succeeded')];
	const wording: [string, string, string, string][] = [
		[
			'site.create',
			'Creating Your Site',
			'The site is ready when every step succeeds.',
			'Could Not Create the Site'
		],
		[
			'site.delete',
			'Deleting Your Site',
			'The site stops serving once its access is revoked.',
			'Could Not Delete the Site'
		],
		[
			'site.upgrade',
			'Updating Your Site',
			'The site keeps serving during the update.',
			'Could Not Update the Site'
		],
		[
			'backup.create',
			'Backing Up Your Site',
			'Leaving this page does not stop the backup.',
			'Could Not Back Up the Site'
		],
		[
			'backup.restore',
			'Restoring a Backup',
			'The backup replaces the site content as the restore runs.',
			'Could Not Restore the Backup'
		]
	];

	for (const [type, title, runningLine, failureTitle] of wording) {
		it(`reads right for ${type} while it runs and when it fails`, async () => {
			opReply = () => ({ body: operation('running', ended, type) });
			const live = await mountPage();
			await vi.waitFor(() => expect(live.find('h1').text()).toBe(title));
			expect(live.text()).toContain(runningLine);
			live.unmount();

			opReply = () => ({
				body: operation(
					'failed',
					[
						step(
							'lease',
							'Take the site writer lease',
							'failed',
							'lease: the lease was lost'
						)
					],
					type
				)
			});
			const failed = await mountPage();
			await vi.waitFor(() => expect(failed.text()).toContain(failureTitle));
			expect(failed.text()).toContain('Stopped while locking the site for this change.');
			expect(failed.text()).not.toContain('the lease was lost');
		});
	}

	it('ends a delete on Site deleted with a link to Sites, and shows no site or admin password', async () => {
		opReply = () => ({ body: operation('succeeded', ended, 'site.delete') });
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Site deleted.'));
		expect(wrapper.text()).toContain('held for 90 days');
		const link = wrapper.findAll('a').find((a) => a.text().trim() === 'Back to Sites');
		expect(link?.attributes('href')).toBe('/sites');
		expect(wrapper.text()).not.toContain('Admin Password');
		expect(wrapper.text()).not.toContain('Reveal Password');
		expect(wrapper.text()).not.toContain('Open Admin');
		expect(calls.map((call) => call.path)).not.toContain('/api/v1/sites/site_1');
		expect(calls.map((call) => call.path.endsWith('/first-run-secret'))).not.toContain(true);
	});

	it('shows the admin password panel only for a create', async () => {
		for (const type of ['site.upgrade', 'backup.create', 'backup.restore']) {
			opReply = () => ({ body: operation('succeeded', ended, type) });
			const wrapper = await mountPage();
			await vi.waitFor(() => expect(wrapper.text()).toContain('Back to the Site'));
			expect(wrapper.text(), type).not.toContain('Admin Password');
			expect(wrapper.text(), type).not.toContain('Reveal Password');
			wrapper.unmount();
		}
		opReply = () => ({ body: operation('succeeded', ended) });
		const create = await mountPage();
		await vi.waitFor(() => expect(create.text()).toContain('Admin Password'));
	});

	it('sends a failed delete back to the site, and says the delete can be run again', async () => {
		opReply = () => ({
			body: operation(
				'failed',
				[step('route', 'Drop the hostname routes', 'failed', 'Cloudflare timed out')],
				'site.delete'
			)
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Delete the Site'));
		expect(wrapper.text()).toContain('Stopped while removing the site address.');
		expect(wrapper.text()).not.toContain('Cloudflare timed out');
		expect(wrapper.text()).toContain('Deleting the site again finishes it');
		const back = wrapper.findAll('button').find((b) => b.text().trim() === 'Back to the Site');
		await back?.trigger('click');
		await vi.waitFor(() => expect(useRouter().currentRoute.value.path).toBe('/sites/site_1'));
	});
});

describe('retry and cleanup of a failed create', () => {
	const retryKey = `POST /api/v1/orgs/${personal.id}/operations/op_1/retry`;
	const cleanupKey = `POST /api/v1/orgs/${personal.id}/sites/site_1/cleanup`;
	const failedCreate = () =>
		operation('rolled-back', [
			step('assets', 'Upload static assets', 'failed', 'assets: name_taken')
		]);
	const button = (wrapper: Awaited<ReturnType<typeof mountPage>>, label: string) =>
		wrapper.findAll('button').find((b) => b.text().trim() === label);

	function registerWith(extra: Record<string, () => Reply>) {
		cleanup();
		cleanup = registerApi({
			'GET /api/v1/me': { body: me },
			'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
			[opKey]: () => opReply(),
			[siteKey]: { body: site },
			[secretKey]: () => secretReply(),
			...extra
		});
	}

	it('starts the retry and opens the progress page of the new attempt', async () => {
		opReply = () => ({ body: failedCreate() });
		registerWith({
			[retryKey]: () => ({
				status: 202,
				body: { ...operation('planned', [], 'site.create'), id: 'op_2' }
			})
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(button(wrapper, 'Try Again')).toBeDefined());
		await button(wrapper, 'Try Again')?.trigger('click');

		await vi.waitFor(() =>
			expect(useRouter().currentRoute.value.path).toBe('/new/progress/op_2')
		);
		const call = calls.find((entry) => entry.path.endsWith('/retry'));
		expect(call?.headers['idempotency-key']).toBeTruthy();
	});

	it('shows the plain reason when the retry is refused and keeps the failure panel', async () => {
		opReply = () => ({ body: failedCreate() });
		registerWith({
			[retryKey]: () => ({
				status: 409,
				body: {
					code: 'conflict',
					message: 'Another change to this site is still running',
					details: {
						reason: 'site_busy',
						operationId: 'op_9',
						operation: 'site.upgrade'
					},
					requestId: 'req_busy'
				}
			})
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(button(wrapper, 'Try Again')).toBeDefined());
		await button(wrapper, 'Try Again')?.trigger('click');

		await vi.waitFor(() =>
			expect(wrapper.findAll('[role="alert"]').map((a) => a.text())).toContain(
				'Another change to this site is still running. Wait for it to finish, then try again.'
			)
		);
		expect(wrapper.text()).not.toContain('site_busy');
		expect(wrapper.text()).toContain('Could Not Create the Site');
	});

	it('offers no Try Again for a failed purge, and shows its plain reason', async () => {
		opReply = () => ({
			body: operation(
				'failed',
				[step('lease', 'Take the site writer lease', 'failed', 'lease: lost')],
				'site.purge'
			)
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(wrapper.text()).toContain('Stopped while locking the site'));
		expect(button(wrapper, 'Try Again')).toBeUndefined();
		expect(button(wrapper, 'Remove This Attempt')).toBeUndefined();
	});

	it('removes the first attempt, then offers Start Over', async () => {
		opReply = () => ({ body: failedCreate() });
		registerWith({
			[cleanupKey]: () => ({
				status: 202,
				body: { ...operation('planned', [], 'repair.run'), id: 'op_3' }
			}),
			[`GET /api/v1/orgs/${personal.id}/operations/op_3`]: () => ({
				body: { ...operation('succeeded', [], 'repair.run'), id: 'op_3' }
			})
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(button(wrapper, 'Remove This Attempt')).toBeDefined());
		await button(wrapper, 'Remove This Attempt')?.trigger('click');

		await vi.waitFor(() => expect(wrapper.find('a[href="/new"]').text()).toBe('Start Over'));
		expect(button(wrapper, 'Remove This Attempt')).toBeUndefined();
		const call = calls.find((entry) => entry.path.endsWith('/cleanup'));
		expect(call?.headers['idempotency-key']).toBeTruthy();
	});

	it('refuses to remove a site that went live, and says why', async () => {
		opReply = () => ({ body: failedCreate() });
		registerWith({
			[cleanupKey]: () => ({
				status: 409,
				body: {
					code: 'conflict',
					message: 'This site is live, so it is not cleaned up',
					details: { reason: 'site_active' },
					requestId: 'req_live'
				}
			})
		});
		const wrapper = await mountPage();

		await vi.waitFor(() => expect(button(wrapper, 'Remove This Attempt')).toBeDefined());
		await button(wrapper, 'Remove This Attempt')?.trigger('click');

		await vi.waitFor(() =>
			expect(
				wrapper
					.findAll('[role="alert"]')
					.map((a) => a.text())
					.join(' ')
			).toContain('This site is live, so it is not removed.')
		);
		expect(button(wrapper, 'Start Over')).toBeUndefined();
	});
});
