import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import EstateDetail from '~/pages/assess/estate/[id].vue';
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
const id = 'asm_0123456789abcdefghijklmnop';
const base = `/api/v1/orgs/${personal.id}/assessments/${id}`;
const proofsBase = `/api/v1/orgs/${personal.id}/assessments/proofs`;
const route = `/assess/estate/${id}`;

const progress = {
	pending: 1,
	checking: 0,
	done: 1,
	'needs access': 0,
	'needs proof': 0,
	'could not check': 0,
	skipped: 0
};
const classes = {
	ready: 1,
	'automatic upgrade': 0,
	'needs decision': 0,
	unsupported: 1,
	information: 0
};

function view(state: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		operationId: 'op_assess',
		state,
		rowCount: 2,
		rejectedTotal: 0,
		progress,
		classes,
		report: null,
		createdAt: '2026-11-13T00:00:00.000Z',
		updatedAt: '2026-11-13T00:00:00.000Z',
		...extra
	};
}

const finishedReport = {
	counts: {
		sites: 2,
		byClass: classes,
		byState: { ...progress, done: 2, pending: 0 },
		notReconciled: 0,
		sharedDatabases: 0,
		duplicateDomains: 0,
		surveyed: 0
	},
	effort: {
		value: null,
		label: 'Not estimated',
		reason: 'effort needs a measured run; this assessment only read the site'
	},
	windows: { value: null, label: 'Not estimated' }
};

const row = (number: number, hostname: string, extra: Record<string, unknown> = {}) => ({
	number,
	hostname,
	aliases: [],
	server: '',
	cms: 'drupal',
	version: '11',
	class: 'ready',
	state: 'done',
	basis: 'hostname',
	reconciled: false,
	missing: null,
	findings: [],
	...extra
});

const proofView = (extra: Record<string, unknown> = {}) => ({
	domain: 'example.test',
	proven: false,
	record: {
		type: 'TXT',
		name: '_drupflare-estate.example.test',
		value: 'drupflare-estate=abc123'
	},
	file: { path: '/.well-known/drupflare-estate.txt', content: 'drupflare-estate=abc123' },
	...extra
});

const proofRow = row(1, 'example.test', {
	class: 'information',
	state: 'needs proof',
	missing: 'proof that you control example.test',
	findings: [{ status: 'information', title: 'Domain Not Proven', detail: 'Prove it.' }]
});

let cleanup: () => void = () => undefined;
let viewReply: () => Reply;
let rowsReply: (query: Record<string, string>) => Reply | Promise<Reply>;
let cancelReply: () => Reply;
let exportReply: () => Reply;
let proofReply: () => Reply;
let proofCheckReply: (call: Call) => Reply;
const mounted: { unmount: () => void }[] = [];

beforeEach(async () => {
	clearBrowserState();
	useSessionStore().$reset();
	useOrgStore().$reset();
	useEstateStore().reset();
	viewReply = () => ({ body: view('running') });
	rowsReply = () => ({
		body: { items: [row(1, 'example.test'), row(2, 'shop.example.test')], nextCursor: null }
	});
	cancelReply = () => ({ body: view('cancelled') });
	exportReply = () => ({ body: 'hostname,class\nexample.test,ready\n' });
	cleanup = registerApi({
		'GET /api/v1/me': { body: me },
		'GET /api/v1/me/organizations': { body: { items: [personal], nextCursor: null } },
		[`GET ${base}`]: () => viewReply(),
		[`GET ${base}/rows`]: (call) => rowsReply(call.query),
		[`POST ${base}/cancel`]: () => cancelReply(),
		[`GET ${base}/export`]: () => exportReply(),
		[`POST ${proofsBase}`]: () => proofReply(),
		[`POST ${proofsBase}/check`]: (call) => proofCheckReply(call)
	});
	proofReply = () => ({ body: proofView() });
	proofCheckReply = () => ({
		body: {
			domain: 'example.test',
			proven: false,
			method: 'dns',
			detail: 'The record was not found yet.'
		}
	});
	await useOrgStore().ensure();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
	vi.restoreAllMocks();
});

type Clickable = { text(): string; trigger(event: string): Promise<unknown> };

function buttonLabelled(wrapper: { findAll(selector: string): Clickable[] }, label: string) {
	return wrapper.findAll('button').find((b) => b.text().trim() === label);
}

async function clickButton(wrapper: { findAll(selector: string): Clickable[] }, label: string) {
	const button = buttonLabelled(wrapper, label);
	if (!button) throw new Error(`no button labelled ${label}`);
	await button.trigger('click');
}

async function mountDetail() {
	const wrapper = await mountSuspended(EstateDetail, { route });
	mounted.push(wrapper);
	return wrapper;
}

async function waitForText(wrapper: { text(): string }, text: string) {
	await vi.waitFor(() => expect(wrapper.text()).toContain(text));
}

describe('estate assessment page, progress', () => {
	it('shows the count of sites checked so far while the run is going', async () => {
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Checking 1 of 2');
		expect(wrapper.text()).toContain('example.test');
		expect(wrapper.text()).toContain('Cancel');
	});

	it('shows the preparing state before the first row is read', async () => {
		viewReply = () => ({ body: view('preparing') });
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Preparing');
	});

	it('shows the report, the effort note and the class counts once the run has finished', async () => {
		viewReply = () => ({
			body: view('finished', {
				report: finishedReport,
				progress: { ...progress, pending: 0, done: 2 }
			})
		});
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Finished');
		expect(wrapper.text()).toContain('Effort: Not estimated.');
		expect(wrapper.text()).toContain('Automatic Upgrade');
		expect(wrapper.text()).not.toContain('Cancel');
	});

	it('shows a run that could not finish', async () => {
		viewReply = () => ({ body: view('failed') });
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Could Not Finish');
	});

	it('shows the not found state when the assessment does not exist', async () => {
		viewReply = () => ({
			status: 404,
			body: { code: 'not_found', message: 'Not found', details: {}, requestId: 'req_9' }
		});
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Could Not Find the Assessment');
	});

	it('shows the load failure with the server message', async () => {
		viewReply = () => failure('internal', 'The assessment could not be read.', 'req_10');
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'The assessment could not be read.');
		expect(wrapper.text()).toContain('Could Not Load the Assessment');
	});
});

describe('estate assessment page, rows', () => {
	it('labels a WordPress row as not supported yet', async () => {
		rowsReply = () => ({
			body: {
				items: [row(1, 'blog.example.test', { cms: 'wordpress', class: 'unsupported' })],
				nextCursor: null
			}
		});
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Not supported yet');
	});

	it('shows a plain message when no row matches the filters', async () => {
		rowsReply = () => ({ body: { items: [], nextCursor: null } });
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'No sites match these filters.');
	});

	it('sends the chosen class and hostname text with the filter', async () => {
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'example.test');
		await wrapper.find('select').setValue('ready');
		await wrapper.find('input[type="text"]').setValue('shop');
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(
				calls.some((call) => call.query.class === 'ready' && call.query.q === 'shop')
			).toBe(true)
		);
	});

	it('loads the next page of rows with the cursor', async () => {
		rowsReply = (query) =>
			query.cursor === 'c1'
				? { body: { items: [row(2, 'shop.example.test')], nextCursor: null } }
				: { body: { items: [row(1, 'example.test')], nextCursor: 'c1' } };
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'example.test');
		await clickButton(wrapper, 'Load More Sites');
		await vi.waitFor(() => expect(wrapper.text()).toContain('shop.example.test'));
	});
});

describe('estate assessment page, rows loading', () => {
	it('applies a filter change made while rows are loading once the load ends', async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => (release = resolve));
		rowsReply = async (query) => {
			if (query.class === 'ready') {
				return { body: { items: [row(2, 'shop.example.test')], nextCursor: null } };
			}
			await held;
			return { body: { items: [row(1, 'example.test')], nextCursor: null } };
		};
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Checking 1 of 2');
		await vi.waitFor(() =>
			expect(calls.some((call) => call.path === `${base}/rows`)).toBe(true)
		);

		await wrapper.find('select').setValue('ready');
		await wrapper.find('form').trigger('submit');
		release();

		await waitForText(wrapper, 'shop.example.test');
		expect(calls.some((call) => call.query.class === 'ready')).toBe(true);
	});
});

describe('estate assessment page, proof', () => {
	function showNeedsProof() {
		viewReply = () => ({
			body: view('running', { progress: { ...progress, pending: 0, 'needs proof': 1 } })
		});
		rowsReply = () => ({ body: { items: [proofRow], nextCursor: null } });
	}

	it('shows the TXT record and the file to publish for a site that needs proof', async () => {
		showNeedsProof();
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Prove Ownership');
		await clickButton(wrapper, 'Prove Ownership');

		await waitForText(wrapper, 'drupflare-estate=abc123');
		expect(wrapper.text()).toContain('_drupflare-estate.example.test');
		expect(wrapper.text()).toContain('/.well-known/drupflare-estate.txt');
		const call = calls.find((entry) => entry.path === proofsBase);
		expect(call?.body).toEqual({ domain: 'example.test' });
	});

	it('checks the proof with the chosen method and says the sites stay at needs proof', async () => {
		proofCheckReply = () => ({
			body: {
				domain: 'example.test',
				proven: true,
				method: 'dns',
				detail: 'The record is in place.'
			}
		});
		showNeedsProof();
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Prove Ownership');
		await clickButton(wrapper, 'Prove Ownership');
		await waitForText(wrapper, 'drupflare-estate=abc123');

		await clickButton(wrapper, 'Check Now');
		await waitForText(wrapper, 'The record is in place.');
		expect(wrapper.text()).toContain('Start a new assessment to check them.');
		const call = calls.find((entry) => entry.path === `${proofsBase}/check`);
		expect(call?.body).toEqual({ domain: 'example.test', method: 'dns' });
	});

	it('says the record was not found yet when the check finds nothing', async () => {
		showNeedsProof();
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Prove Ownership');
		await clickButton(wrapper, 'Prove Ownership');
		await waitForText(wrapper, 'drupflare-estate=abc123');

		await clickButton(wrapper, 'Check Now');
		await waitForText(wrapper, 'The record was not found yet.');
	});

	it('shows the server message when the proof cannot be made', async () => {
		showNeedsProof();
		proofReply = () =>
			failure('unprocessable', 'Enter a domain such as example.edu.', 'req_13');
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Prove Ownership');
		await clickButton(wrapper, 'Prove Ownership');
		await waitForText(wrapper, 'Enter a domain such as example.edu.');
	});
});

describe('estate assessment page, actions', () => {
	it('cancels the run and shows the cancelled state', async () => {
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Checking 1 of 2');
		await clickButton(wrapper, 'Cancel');
		await waitForText(wrapper, 'Cancelled');
		expect(buttonLabelled(wrapper, 'Cancel')).toBeUndefined();
	});

	it('shows the server message when the cancel is refused', async () => {
		cancelReply = () => ({
			status: 409,
			body: {
				code: 'conflict',
				message: 'This assessment has already finished.',
				details: {},
				requestId: 'req_11'
			}
		});
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Checking 1 of 2');
		await clickButton(wrapper, 'Cancel');
		await waitForText(wrapper, 'This assessment has already finished.');
	});

	it('downloads the CSV export through a object URL', async () => {
		const createObjectURL = vi.fn(() => 'blob:estate');
		const revokeObjectURL = vi.fn();
		vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
		vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
		// a real click would navigate the test window to the blob URL
		const click = vi
			.spyOn(HTMLAnchorElement.prototype, 'click')
			.mockImplementation(() => undefined);
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Checking 1 of 2');

		await clickButton(wrapper, 'Export CSV');
		await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(1));
		expect(calls.some((call) => call.path === `${base}/export`)).toBe(true);
		expect(click).toHaveBeenCalledTimes(1);
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:estate');
	});

	it('shows the server message when the export is refused', async () => {
		exportReply = () => failure('internal', 'The export could not be built.', 'req_12');
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Checking 1 of 2');
		await clickButton(wrapper, 'Export CSV');
		await waitForText(wrapper, 'The export could not be built.');
	});

	it('opens the print dialog from the print button', async () => {
		// this environment has no print method on window, so one is defined for the test
		const print = vi.fn();
		Object.defineProperty(window, 'print', {
			value: print,
			configurable: true,
			writable: true
		});
		const wrapper = await mountDetail();
		await waitForText(wrapper, 'Checking 1 of 2');
		await clickButton(wrapper, 'Print Report');
		expect(print).toHaveBeenCalledTimes(1);
		Reflect.deleteProperty(window, 'print');
	});
});
