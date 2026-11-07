import { mockNuxtImport, mountSuspended, registerEndpoint } from '@nuxt/test-utils/runtime';
import { defineEventHandler, getRequestURL, setResponseHeader, setResponseStatus } from 'h3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import Panel from '~/components/site/backup/Panel.vue';
import Restore from '~/components/site/backup/Restore.vue';
import Table from '~/components/site/backup/Table.vue';
import { useBackupsStore, type BackupView } from '~/stores/backups';
import { useSessionStore } from '~/stores/session';
import { useSitesStore, type SiteSummary } from '~/stores/sites';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_a';
const SITE = 'site_1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const apiPath = (suffix: string) => `/api/v1/orgs/${ORG}/sites/${SITE}${suffix}`;
const backupsPath = `GET ${apiPath('/backups')}`;
const createPath = `POST ${apiPath('/backups')}`;
const sitesPath = `GET /api/v1/orgs/${ORG}/sites`;
const restorePath = (id: string) => `POST ${apiPath(`/backups/${id}/restore`)}`;
const exportUrl = (id: string) => apiPath(`/backups/${id}/export`);

function backup(id: string, overrides: Partial<BackupView> = {}): BackupView {
	return {
		id,
		siteId: SITE,
		operationId: `op_${id}`,
		bytes: 2048,
		sha256: 'a'.repeat(64),
		parts: 1,
		restorable: true,
		notRestorableReason: null,
		verified: true,
		label: null,
		createdAt: '2026-11-01T12:00:00.000Z',
		...overrides
	};
}

function site(id: string, name = `Site ${id}`): SiteSummary {
	return {
		id,
		orgId: ORG,
		name,
		kind: 'drupal',
		category: 'cms',
		plane: 'managed',
		config: 'managed',
		accountId: null,
		state: 'active',
		ring: 'R1',
		primaryHostname: null,
		hostnames: [],
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z'
	};
}

const page = <T>(items: T[], nextCursor: string | null = null) => ({
	body: { items, nextCursor }
});

const operation = (id: string) => ({ status: 202, body: { id, type: 'site.backup' } });

const failure = (status: number, code: string, message: string) => ({
	status,
	body: { code, message, details: {}, requestId: 'req_test' }
});

const cleanups: (() => void)[] = [];
const mounted: { unmount: () => void }[] = [];
const exported: string[] = [];
let downloads: { download: string }[] = [];
let objectUrls = 0;

const register = (routes: Parameters<typeof registerApi>[0]) => {
	cleanups.push(registerApi(routes));
};

async function mountPanel() {
	const wrapper = await mountSuspended(Panel, { props: { orgId: ORG, siteId: SITE } });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: { findAll: (selector: string) => any[] }, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text().includes(text));

const dialogSelect = () => document.querySelector<HTMLSelectElement>('#restore-target');
const dialogBox = () => document.querySelector<HTMLInputElement>('input[type="checkbox"]');
const dialogSubmit = () => document.querySelector<HTMLButtonElement>('button[type="submit"]');

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useBackupsStore().$reset();
	useSitesStore().$reset();
	navigate.mockReset();
	exported.length = 0;
	downloads = [];
	objectUrls = 0;
	URL.createObjectURL = vi.fn(() => {
		objectUrls += 1;
		return `blob:backup-${objectUrls}`;
	});
	URL.revokeObjectURL = vi.fn();
	vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
		this: HTMLAnchorElement
	) {
		downloads.push({ download: this.download });
	});
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanups.splice(0).forEach((cleanup) => cleanup());
	vi.restoreAllMocks();
});

describe('backup panel', () => {
	it('shows the loading state until the first page arrives', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		register({
			[backupsPath]: async () => {
				await gate;
				return page([backup('bk_1')]);
			}
		});

		const wrapper = await mountPanel();
		expect(wrapper.text()).toContain('Loading backups...');

		release();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Verified'));
	});

	it('shows the error with its request ID, then recovers on Try Again', async () => {
		let fail = true;
		register({
			[backupsPath]: () =>
				fail
					? {
							status: 500,
							body: {
								code: 'internal',
								message: 'Could not read',
								details: {},
								requestId: 'req_b1'
							}
						}
					: page([backup('bk_1')])
		});

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Could Not Load Backups'));
		expect(wrapper.text()).toContain('req_b1');

		fail = false;
		await button(wrapper, 'Try Again')!.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Verified'));
	});

	it('shows the empty state when the site has no backups', async () => {
		register({ [backupsPath]: page([]) });

		const wrapper = await mountPanel();

		await vi.waitFor(() => expect(wrapper.text()).toContain('No Backups Yet'));
	});

	it('appends the next page on Load More with its cursor', async () => {
		register({
			[backupsPath]: ({ query }) =>
				query.cursor === 'next'
					? page([backup('bk_2', { createdAt: '2026-10-01T12:00:00.000Z' })])
					: page([backup('bk_1')], 'next')
		});

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.findAll('time')).toHaveLength(1));
		await button(wrapper, 'Load More')!.trigger('click');

		await vi.waitFor(() => expect(wrapper.findAll('time')).toHaveLength(2));
		expect(calls.at(-1)?.query).toEqual({ cursor: 'next' });
	});

	it('Back Up Now posts once with an Idempotency-Key and leads to the progress screen', async () => {
		register({ [backupsPath]: page([]), [createPath]: operation('op_9') });

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Backups Yet'));
		await button(wrapper, 'Back Up Now')!.trigger('click');

		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_9'));
		const posts = calls.filter((call) => call.method === 'POST');
		expect(posts).toHaveLength(1);
		expect(posts[0]?.body).toEqual({});
		expect(posts[0]?.headers['idempotency-key']).toMatch(UUID);
		expect(wrapper.text()).toContain('Backup Started');
	});

	it('a double click while the start is pending sends one request', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		register({
			[backupsPath]: page([]),
			[createPath]: async () => {
				await gate;
				return operation('op_9');
			}
		});

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Backups Yet'));
		const trigger = button(wrapper, 'Back Up Now')!;
		await trigger.trigger('click');
		await trigger.trigger('click');
		release();

		await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
		expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
	});

	it('a click after the start finishes sends a new key', async () => {
		register({ [backupsPath]: page([]), [createPath]: operation('op_9') });

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Backups Yet'));
		await button(wrapper, 'Back Up Now')!.trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
		await button(wrapper, 'Back Up Now')!.trigger('click');
		await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(2));

		const keys = calls
			.filter((call) => call.method === 'POST')
			.map((call) => call.headers['idempotency-key']);
		expect(keys).toHaveLength(2);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it('shows a create error in place and does not navigate', async () => {
		register({
			[backupsPath]: page([]),
			[createPath]: failure(409, 'conflict', 'A backup is already running')
		});

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No Backups Yet'));
		await button(wrapper, 'Back Up Now')!.trigger('click');

		await vi.waitFor(() => expect(wrapper.text()).toContain('A backup is already running'));
		expect(navigate).not.toHaveBeenCalled();
	});

	it('downloads the file from its route and names it from Content-Disposition', async () => {
		register({ [backupsPath]: page([backup('bk_1')]) });
		cleanups.push(
			registerEndpoint(exportUrl('bk_1'), {
				method: 'GET',
				handler: defineEventHandler((event) => {
					exported.push(getRequestURL(event).pathname);
					setResponseHeader(
						event,
						'content-disposition',
						'attachment; filename="bk_1.sql"'
					);
					return 'CREATE TABLE node (nid integer);';
				})
			})
		);

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Verified'));
		await button(wrapper, 'Download')!.trigger('click');

		await vi.waitFor(() => expect(downloads).toHaveLength(1));
		expect(exported).toEqual([`/_${exportUrl('bk_1')}`]);
		expect(downloads[0]?.download).toBe('bk_1.sql');
	});

	it('a 403 on download says a fresh sign-in is needed and links to the account page', async () => {
		register({ [backupsPath]: page([backup('bk_1')]) });
		cleanups.push(
			registerEndpoint(exportUrl('bk_1'), {
				method: 'GET',
				handler: defineEventHandler((event) => {
					setResponseStatus(event, 403);
					return {
						code: 'forbidden',
						message: 'This action needs a signed-in session',
						details: {},
						requestId: 'req_x'
					};
				})
			})
		);

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Verified'));
		await button(wrapper, 'Download')!.trigger('click');

		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('Downloading needs a fresh sign-in')
		);
		expect(wrapper.find('a[href="/account"]').exists()).toBe(true);
		expect(downloads).toHaveLength(0);
	});

	it('Restore opens the dialog for that row', async () => {
		register({
			[backupsPath]: page([backup('bk_1')]),
			[sitesPath]: page([site(SITE), site('site_2')])
		});

		const wrapper = await mountPanel();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Verified'));
		await button(wrapper, 'Restore')!.trigger('click');

		await vi.waitFor(() => expect(dialogSelect()).not.toBeNull());
		expect(document.body.textContent).toContain('Restore Backup');
	});
});

describe('backup table', () => {
	it('lists rows newest first', async () => {
		const wrapper = await mountSuspended(Table, {
			props: {
				downloading: null,
				backups: [
					backup('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
					backup('new', { createdAt: '2026-11-01T00:00:00.000Z' }),
					backup('mid', { createdAt: '2026-06-01T00:00:00.000Z' })
				]
			}
		});
		mounted.push(wrapper);

		const times = wrapper.findAll('time').map((cell) => cell.attributes('datetime'));
		expect(times).toEqual([
			'2026-11-01T00:00:00.000Z',
			'2026-06-01T00:00:00.000Z',
			'2026-01-01T00:00:00.000Z'
		]);
	});

	it('shows the verified state as an icon and text', async () => {
		const wrapper = await mountSuspended(Table, {
			props: {
				downloading: null,
				backups: [backup('ok'), backup('pending', { verified: false })]
			}
		});
		mounted.push(wrapper);

		expect(wrapper.text()).toContain('Verified');
		expect(wrapper.text()).toContain('Not Verified Yet');
		expect(wrapper.html()).toContain('circle-check');
		expect(wrapper.html()).toContain('clock');
	});

	it('shows the size in plain units', async () => {
		const wrapper = await mountSuspended(Table, {
			props: { downloading: null, backups: [backup('big', { bytes: 1536 })] }
		});
		mounted.push(wrapper);

		expect(wrapper.text()).toContain('1.5 KB');
	});

	it('disables Restore for a backup too large to restore and gives the reason', async () => {
		const wrapper = await mountSuspended(Table, {
			props: {
				downloading: null,
				backups: [
					backup('large', {
						restorable: false,
						notRestorableReason: 'The dump is 300.0 MiB. You can still export it.'
					})
				]
			}
		});
		mounted.push(wrapper);

		expect(button(wrapper, 'Restore')!.attributes('disabled')).toBeDefined();
		expect(wrapper.text()).toContain('You can still export it.');
	});
});

describe('restore dialog', () => {
	async function mountRestore(backupId = 'bk_1') {
		const wrapper = await mountSuspended(Restore, {
			props: { orgId: ORG, siteId: SITE, backup: backup(backupId) }
		});
		mounted.push(wrapper);
		return wrapper;
	}

	it('lists the other sites in the organization and never the source', async () => {
		register({ [sitesPath]: page([site(SITE), site('site_2'), site('site_3')]) });

		await mountRestore();

		await vi.waitFor(() => expect(dialogSelect()?.options).toHaveLength(3));
		const values = Array.from(dialogSelect()!.options).map((option) => option.value);
		expect(values).toEqual(['', 'site_2', 'site_3']);
	});

	it('says so and links to create a site when there is no other site', async () => {
		register({ [sitesPath]: page([site(SITE)]) });

		await mountRestore();

		await vi.waitFor(() =>
			expect(document.body.textContent).toContain('no other site to restore into')
		);
		expect(document.querySelector('a[href="/new"]')).not.toBeNull();
		expect(dialogSelect()).toBeNull();
	});

	it('keeps the restore button off until a target and the box are both set', async () => {
		register({ [sitesPath]: page([site(SITE), site('site_2')]) });

		await mountRestore();
		await vi.waitFor(() => expect(dialogSelect()).not.toBeNull());
		expect(dialogSubmit()?.disabled).toBe(true);

		dialogSelect()!.value = 'site_2';
		dialogSelect()!.dispatchEvent(new Event('change'));
		await nextTick();
		expect(dialogSubmit()?.disabled).toBe(true);

		dialogBox()!.checked = true;
		dialogBox()!.dispatchEvent(new Event('change'));
		await nextTick();
		expect(dialogSubmit()?.disabled).toBe(false);
	});

	it('posts the target with a fresh key and navigates to the progress screen', async () => {
		register({
			[sitesPath]: page([site(SITE), site('site_2')]),
			[restorePath('bk_1')]: operation('op_7')
		});

		await mountRestore();
		await vi.waitFor(() => expect(dialogSelect()).not.toBeNull());
		dialogSelect()!.value = 'site_2';
		dialogSelect()!.dispatchEvent(new Event('change'));
		dialogBox()!.checked = true;
		dialogBox()!.dispatchEvent(new Event('change'));
		await nextTick();

		dialogSelect()!
			.closest('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }));

		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_7'));
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.path).toBe(apiPath('/backups/bk_1/restore'));
		expect(post?.body).toEqual({ targetSiteId: 'site_2' });
		expect(post?.headers['idempotency-key']).toMatch(UUID);
	});

	it.each([
		[409, 'conflict', 'The target site is already being restored'],
		[404, 'not_found', 'Not found'],
		[422, 'unprocessable', 'The dump is too large for this site']
	])('shows the %i message in place and does not navigate', async (status, code, message) => {
		register({
			[sitesPath]: page([site(SITE), site('site_2')]),
			[restorePath('bk_1')]: failure(status, code, message)
		});

		await mountRestore();
		await vi.waitFor(() => expect(dialogSelect()).not.toBeNull());
		dialogSelect()!.value = 'site_2';
		dialogSelect()!.dispatchEvent(new Event('change'));
		dialogBox()!.checked = true;
		dialogBox()!.dispatchEvent(new Event('change'));
		await nextTick();

		dialogSelect()!
			.closest('form')!
			.dispatchEvent(new Event('submit', { cancelable: true }));

		await vi.waitFor(() => expect(document.body.textContent).toContain(message));
		expect(navigate).not.toHaveBeenCalled();
	});
});
