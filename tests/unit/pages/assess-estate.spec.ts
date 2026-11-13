import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstateIndex from '~/pages/assess/estate/index.vue';
import { useEstateStore } from '~/stores/estate';
import { useOrgStore } from '~/stores/org';
import { useSessionStore } from '~/stores/session';
import {
	calls,
	clearBrowserState,
	failure,
	registerApi,
	type Call,
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
const base = `/api/v1/orgs/${personal.id}`;
const checkKey = `POST ${base}/assessments/check`;
const startKey = `POST ${base}/assessments`;

const checkView = {
	fileError: null,
	rows: 3,
	sites: 2,
	notReconciled: 1,
	rejected: [{ line: 4, reason: 'missing hostname' }],
	rejectedTotal: 1,
	ignoredColumns: ['colour']
};
const assessment = {
	id: 'asm_0123456789abcdefghijklmnop',
	operationId: 'op_assess',
	state: 'preparing',
	rowCount: 2,
	rejectedTotal: 1,
	progress: {
		pending: 2,
		checking: 0,
		done: 0,
		'needs access': 0,
		'needs proof': 0,
		'could not check': 0,
		skipped: 0
	},
	classes: {
		ready: 0,
		'automatic upgrade': 0,
		'needs decision': 0,
		unsupported: 0,
		information: 0
	},
	report: null,
	createdAt: '2026-11-13T00:00:00.000Z',
	updatedAt: '2026-11-13T00:00:00.000Z'
};

const listKey = `GET ${base}/assessments`;
const other = { ...assessment, id: 'asm_zyxwvutsrqponmlkjihgfedcba', state: 'finished' };

let cleanup: () => void = () => undefined;
let checkReply: () => Reply;
let startReply: () => Reply;
let listReply: (call: Call) => Reply | Promise<Reply>;
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useEstateStore().reset();
	checkReply = () => ({ body: checkView });
	startReply = () => ({ status: 202, body: assessment });
	listReply = () => ({ body: { items: [], nextCursor: null } });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[checkKey]: () => checkReply(),
		[startKey]: () => startReply(),
		[listKey]: (call) => listReply(call)
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

type Clickable = {
	text(): string;
	trigger(event: string): Promise<unknown>;
	attributes(name: string): string | undefined;
};

function buttonLabelled(wrapper: { findAll(selector: string): Clickable[] }, label: string) {
	return wrapper.findAll('button').find((b) => b.text().trim() === label);
}

async function clickButton(wrapper: { findAll(selector: string): Clickable[] }, label: string) {
	const button = buttonLabelled(wrapper, label);
	if (!button) throw new Error(`no button labelled ${label}`);
	await button.trigger('click');
}

async function mountEstate() {
	const wrapper = await mountSuspended(EstateIndex, { route: '/assess/estate' });
	mounted.push(wrapper);
	await vi.waitFor(() => expect(wrapper.text()).toContain('Assess an Estate'));
	return wrapper;
}

async function waitForText(wrapper: { text(): string }, text: string) {
	await vi.waitFor(() => expect(wrapper.text()).toContain(text));
}

async function pasteInventory(wrapper: Awaited<ReturnType<typeof mountEstate>>, text: string) {
	await wrapper.find('#estate-text').setValue(text);
}

describe('assess an estate, past assessments', () => {
	it('shows a plain message when the organisation has no assessments yet', async () => {
		const wrapper = await mountEstate();
		await waitForText(wrapper, 'You have not run an assessment yet.');
	});

	it('shows the loading state until the list answers', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		listReply = async () => {
			await held;
			return { body: { items: [assessment], nextCursor: null } };
		};
		const wrapper = await mountEstate();
		await waitForText(wrapper, 'Loading the assessments');

		release();
		await waitForText(wrapper, 'Preparing');
		expect(wrapper.text()).not.toContain('Loading the assessments');
	});

	it('lists each past assessment with its state, date and counts, linked to its report', async () => {
		listReply = () => ({ body: { items: [assessment, other], nextCursor: null } });
		const wrapper = await mountEstate();
		await waitForText(wrapper, 'Finished');
		expect(wrapper.text()).toContain('Preparing');
		expect(wrapper.text()).toContain('Rejected Rows');
		expect(wrapper.find(`a[href="/assess/estate/${assessment.id}"]`).exists()).toBe(true);
		expect(wrapper.find(`a[href="/assess/estate/${other.id}"]`).exists()).toBe(true);
	});

	it('shows the server message when the list is refused', async () => {
		listReply = () => failure('internal', 'The past assessments could not be read.', 'req_20');
		const wrapper = await mountEstate();
		await waitForText(wrapper, 'The past assessments could not be read.');
	});

	it('loads the next page of past assessments with the cursor', async () => {
		listReply = (call) =>
			call.query.cursor === 'c1'
				? { body: { items: [other], nextCursor: null } }
				: { body: { items: [assessment], nextCursor: 'c1' } };
		const wrapper = await mountEstate();
		await waitForText(wrapper, 'Load More Assessments');
		await clickButton(wrapper, 'Load More Assessments');
		await vi.waitFor(() =>
			expect(wrapper.find(`a[href="/assess/estate/${other.id}"]`).exists()).toBe(true)
		);
	});
});

describe('assess an estate, the index page', () => {
	it('lists the columns the inventory can carry', async () => {
		const wrapper = await mountEstate();
		expect(wrapper.text()).toContain('site_uuid');
		expect(wrapper.text()).toContain('Only hostname is required');
	});

	it('refuses an empty inventory before it sends anything', async () => {
		const wrapper = await mountEstate();
		await clickButton(wrapper, 'Check the Inventory');
		expect(wrapper.text()).toContain('Add an inventory before you check it.');
		expect(calls.some((call) => call.path.endsWith('/assessments/check'))).toBe(false);
	});

	it('refuses an inventory larger than the 1 MiB limit before it sends anything', async () => {
		const wrapper = await mountEstate();
		await pasteInventory(wrapper, 'a'.repeat(1_048_577));
		await clickButton(wrapper, 'Check the Inventory');
		expect(wrapper.text()).toContain('The inventory is larger than 1 MiB.');
		expect(calls.some((call) => call.path.endsWith('/assessments/check'))).toBe(false);
	});

	it('fills the text box from a chosen file', async () => {
		const wrapper = await mountEstate();
		const input = wrapper.find('input[type="file"]');
		Object.defineProperty(input.element, 'files', {
			value: [{ name: 'estate.csv', text: async () => 'hostname\nexample.test\n' }]
		});
		await input.trigger('change');
		await vi.waitFor(() =>
			expect((wrapper.find('#estate-text').element as HTMLTextAreaElement).value).toBe(
				'hostname\nexample.test\n'
			)
		);
		expect(wrapper.text()).toContain('Loaded estate.csv.');
	});

	it('shows a plain message when the chosen file cannot be read', async () => {
		const wrapper = await mountEstate();
		const input = wrapper.find('input[type="file"]');
		Object.defineProperty(input.element, 'files', {
			value: [
				{
					name: 'estate.csv',
					text: () => Promise.reject(new Error('read failed'))
				}
			]
		});
		await input.trigger('change');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain(
				'The file could not be read. Choose it again or paste the text.'
			)
		);
	});

	it('shows the counts and the rejected rows from the check', async () => {
		const wrapper = await mountEstate();
		await pasteInventory(wrapper, 'hostname\nexample.test\n\n');
		await clickButton(wrapper, 'Check the Inventory');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Check Results'));

		expect(wrapper.text()).toContain('Not Reconciled');
		expect(wrapper.text()).toContain('Ignored columns: colour');
		expect(wrapper.text()).toContain('missing hostname');
		const call = calls.find((entry) => entry.path.endsWith('/assessments/check'));
		expect(call?.body).toEqual({ text: 'hostname\nexample.test\n\n' });
	});

	it('shows a file-level refusal and keeps the start button off', async () => {
		checkReply = () => ({
			body: { ...checkView, fileError: 'The file is not CSV or JSON.', sites: 0, rows: 0 }
		});
		const wrapper = await mountEstate();
		await pasteInventory(wrapper, '\u0000\u0001');
		await clickButton(wrapper, 'Check the Inventory');
		await vi.waitFor(() => expect(wrapper.text()).toContain('The file is not CSV or JSON.'));

		const start = buttonLabelled(wrapper, 'Start the Assessment');
		expect(start?.attributes('disabled')).toBeDefined();
	});

	it('starts the assessment with an Idempotency-Key and leaves the rest of the inventory alone', async () => {
		const wrapper = await mountEstate();
		await pasteInventory(wrapper, 'hostname\nexample.test\n');
		await clickButton(wrapper, 'Check the Inventory');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Check Results'));

		await clickButton(wrapper, 'Start the Assessment');
		await vi.waitFor(() =>
			expect(
				calls.some(
					(entry) => entry.path === `${base}/assessments` && entry.method === 'POST'
				)
			).toBe(true)
		);
		const call = calls.find(
			(entry) => entry.path === `${base}/assessments` && entry.method === 'POST'
		);
		expect(call?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
		expect(call?.body).toEqual({ text: 'hostname\nexample.test\n' });
	});

	it('clears the check when the text changes, so the old result cannot start a new run', async () => {
		const wrapper = await mountEstate();
		await pasteInventory(wrapper, 'hostname\nexample.test\n');
		await clickButton(wrapper, 'Check the Inventory');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Check Results'));

		await pasteInventory(wrapper, 'hostname\nother.test\n');
		await vi.waitFor(() => expect(wrapper.text()).not.toContain('Check Results'));
	});

	it('shows the server message when the check is refused', async () => {
		checkReply = () => ({
			status: 500,
			body: {
				code: 'internal',
				message: 'Try the check again.',
				details: {},
				requestId: 'req_3'
			}
		});
		const wrapper = await mountEstate();
		await pasteInventory(wrapper, 'hostname\nexample.test\n');
		await clickButton(wrapper, 'Check the Inventory');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Try the check again.'));
	});

	it('shows the server message when the start is refused', async () => {
		startReply = () => ({
			status: 409,
			body: {
				code: 'conflict',
				message: 'That assessment is already running.',
				details: {},
				requestId: 'req_4'
			}
		});
		const wrapper = await mountEstate();
		await pasteInventory(wrapper, 'hostname\nexample.test\n');
		await clickButton(wrapper, 'Check the Inventory');
		await vi.waitFor(() => expect(wrapper.text()).toContain('Check Results'));

		await clickButton(wrapper, 'Start the Assessment');
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('That assessment is already running.')
		);
	});
});
