import { mockNuxtImport, mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Table from '~/components/site/deploy/Table.vue';
import Form from '~/components/site/modify/Form.vue';
import { useReleasesStore, type RevisionItem } from '~/stores/releases';
import { useSessionStore } from '~/stores/session';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const navigate = vi.hoisted(() => vi.fn());
mockNuxtImport('navigateTo', () => navigate);

const ORG = 'org_a';
const SITE = 'site_1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const modifyPath = `POST /api/v1/orgs/${ORG}/sites/${SITE}/modify`;
const rollbackPath = `${modifyPath}/rollback`;

const cleanups: (() => void)[] = [];
const mounted: { unmount: () => void }[] = [];

beforeEach(() => {
	clearBrowserState();
	useSessionStore().$reset();
	useReleasesStore().$reset();
	navigate.mockReset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanups.splice(0).forEach((cleanup) => cleanup());
});

async function mountForm() {
	const wrapper = await mountSuspended(Form, { props: { orgId: ORG, siteId: SITE } });
	mounted.push(wrapper);
	return wrapper;
}

const button = (wrapper: Awaited<ReturnType<typeof mountForm>>, text: string) =>
	wrapper.findAll('button').find((candidate) => candidate.text() === text);

async function openForm() {
	const wrapper = await mountForm();
	await button(wrapper, 'Deliver an Edit')!.trigger('click');
	return wrapper;
}

async function fill(
	wrapper: Awaited<ReturnType<typeof mountForm>>,
	selector: string,
	value: string
) {
	await wrapper.find(selector).setValue(value);
}

async function pasteFile(
	wrapper: Awaited<ReturnType<typeof mountForm>>,
	rest: string,
	content: string
) {
	await button(wrapper, 'Add a Pasted File')!.trigger('click');
	await wrapper.find('input[id^="edit-path-"]').setValue(rest);
	await wrapper.find('textarea').setValue(content);
}

describe('deliver an edit form', () => {
	it('shows only the opening button until it is chosen', async () => {
		const wrapper = await mountForm();
		expect(wrapper.find('form').exists()).toBe(false);
		await button(wrapper, 'Deliver an Edit')!.trigger('click');
		expect(wrapper.find('form').exists()).toBe(true);
	});

	it('keeps the submit button off until the name, a file and a note are there', async () => {
		const wrapper = await openForm();
		const submit = () => button(wrapper, 'Deliver the Edit')!.attributes('disabled');
		expect(submit()).toBeDefined();
		await fill(wrapper, '#edit-name', 'my_module');
		await pasteFile(wrapper, 'my_module.module', '<?php');
		expect(submit()).toBeDefined();
		await fill(wrapper, '#edit-note', 'Fix the header');
		expect(submit()).toBeUndefined();
	});

	it('says what is wrong with a machine name and a path', async () => {
		const wrapper = await openForm();
		await fill(wrapper, '#edit-name', 'My Module');
		expect(wrapper.text()).toContain('Use a machine name');
		await fill(wrapper, '#edit-name', 'my_module');
		await pasteFile(wrapper, '../escape.php', '<?php');
		expect(wrapper.text()).toContain('A path cannot hold .. or empty parts.');
		expect(button(wrapper, 'Deliver the Edit')!.attributes('disabled')).toBeDefined();
	});

	it('refuses a note longer than the site keeps', async () => {
		const wrapper = await openForm();
		await fill(wrapper, '#edit-note', 'x'.repeat(201));
		expect(wrapper.text()).toContain('Keep the note to 200 characters.');
	});

	it('posts the folder path, content and note with a fresh key and follows the operation', async () => {
		cleanups.push(registerApi({ [modifyPath]: { status: 202, body: { id: 'op_9' } } }));
		const wrapper = await openForm();
		await fill(wrapper, '#edit-name', 'my_module');
		await pasteFile(wrapper, 'my_module.module', '<?php');
		await fill(wrapper, '#edit-note', 'Fix the header');

		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_9'));
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.body).toEqual({
			files: [{ path: 'modules/custom/my_module/my_module.module', content: '<?php' }],
			note: 'Fix the header'
		});
		expect(post?.headers['idempotency-key']).toMatch(UUID);
	});

	it('shows the refusal the server gives and stays on the page', async () => {
		cleanups.push(
			registerApi({
				[modifyPath]: {
					status: 422,
					body: {
						code: 'unprocessable',
						message: 'Delivering your own code is not included on this plan.',
						details: { reason: 'feature_not_included' },
						requestId: 'req_test'
					}
				}
			})
		);
		const wrapper = await openForm();
		await fill(wrapper, '#edit-name', 'my_module');
		await pasteFile(wrapper, 'my_module.module', '<?php');
		await fill(wrapper, '#edit-note', 'Fix');

		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() => expect(wrapper.text()).toContain('is not included on this plan'));
		expect(navigate).not.toHaveBeenCalled();
	});
});

function revision(overrides: Partial<RevisionItem> = {}): RevisionItem {
	return {
		id: 'rev_op_a',
		kind: 'edit',
		release: null,
		version: null,
		note: 'Fix the header',
		bundle: true,
		current: false,
		createdAt: 1_790_000_000_000,
		...overrides
	} as RevisionItem;
}

async function mountTable(items: RevisionItem[]) {
	const wrapper = await mountSuspended(Table, { props: { orgId: ORG, siteId: SITE, items } });
	mounted.push(wrapper);
	return wrapper;
}

describe('release history with edits', () => {
	it('shows the note and a Roll Back button on an edit that kept its files', async () => {
		const wrapper = await mountTable([revision()]);
		expect(wrapper.text()).toContain('Edit');
		expect(wrapper.text()).toContain('Fix the header');
		expect(wrapper.findAll('button').some((item) => item.text() === 'Roll Back')).toBe(true);
	});

	it('shows no Roll Back on an edit without files and none on the running one', async () => {
		const wrapper = await mountTable([
			revision({ id: 'rev_op_b', bundle: false }),
			revision({ id: 'rev_op_c', current: true })
		]);
		expect(wrapper.findAll('button').some((item) => item.text() === 'Roll Back')).toBe(false);
		expect(wrapper.text()).toContain('Running Now');
	});

	it('confirms before sending, then posts the revision id with a fresh key', async () => {
		cleanups.push(registerApi({ [rollbackPath]: { status: 202, body: { id: 'op_10' } } }));
		const wrapper = await mountTable([revision()]);
		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Roll Back')!
			.trigger('click');
		expect(calls.find((call) => call.method === 'POST')).toBeUndefined();

		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Confirm Roll Back')!
			.trigger('click');

		await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/new/progress/op_10'));
		const post = calls.find((call) => call.method === 'POST');
		expect(post?.body).toEqual({ revision: 'rev_op_a' });
		expect(post?.headers['idempotency-key']).toMatch(UUID);
	});

	it('shows the refusal and leaves the page when the roll back is refused', async () => {
		cleanups.push(
			registerApi({
				[rollbackPath]: {
					status: 422,
					body: {
						code: 'unprocessable',
						message: 'The files for this edit are no longer stored.',
						details: { reason: 'bundle_missing' },
						requestId: 'req_test'
					}
				}
			})
		);
		const wrapper = await mountTable([revision()]);
		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Roll Back')!
			.trigger('click');
		await wrapper
			.findAll('button')
			.find((item) => item.text() === 'Confirm Roll Back')!
			.trigger('click');
		await vi.waitFor(() => expect(wrapper.text()).toContain('no longer stored'));
		expect(navigate).not.toHaveBeenCalled();
	});
});
