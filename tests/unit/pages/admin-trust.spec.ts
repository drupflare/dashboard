import { mountSuspended } from '@nuxt/test-utils/runtime';
import type { VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdminTrustPage from '~/pages/admin/trust.vue';
import type { TrustDocumentView } from '~/shared/trust';
import { useTrustStore } from '~/stores/trust';
import { calls, clearBrowserState, registerApi } from '../stores/store-support';

const admin = '/api/v1/admin/trust/documents';

const live: TrustDocumentView = {
	id: 'doc_1',
	title: 'Accessibility report',
	kind: 'vpat',
	version: '2026.1',
	contentType: 'application/pdf',
	sizeBytes: 2048,
	sha256: 'b'.repeat(64),
	publishedAt: '2026-11-01T00:00:00.000Z',
	retiredAt: null
};
const draft: TrustDocumentView = {
	...live,
	id: 'doc_2',
	title: 'Draft policy',
	kind: 'policy',
	publishedAt: null
};
const old: TrustDocumentView = {
	...live,
	id: 'doc_3',
	title: 'Old report',
	retiredAt: '2026-10-01T00:00:00.000Z'
};

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	const wrapper = await mountSuspended(AdminTrustPage, { route: '/admin/trust' });
	mounted.push(wrapper);
	return wrapper;
}

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

// the form labels wrap their control, so the control is found from its label text
const control = (wrapper: VueWrapper, label: string) =>
	wrapper
		.findAll('label')
		.find((node) => node.text().startsWith(label))!
		.find<HTMLInputElement>('input, select, textarea');

beforeEach(() => {
	clearBrowserState();
	useTrustStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('admin trust page: the list', () => {
	it('shows drafts, published and retired documents, and offers only the step that applies', async () => {
		cleanup = registerApi({ [`GET ${admin}`]: { body: { items: [draft, live, old] } } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain(draft.title));

		expect(wrapper.text()).toContain('draft');
		expect(wrapper.text()).toContain('published');
		expect(wrapper.text()).toContain('retired');
		const buttons = wrapper.findAll('button').map((button) => button.text());
		expect(buttons).toContain(`Publish ${draft.title}`);
		expect(buttons).toContain(`Retire ${live.title}`);
		expect(buttons.filter((text) => text.includes(old.title))).toEqual([]);
	});

	it('shows the empty state for a platform with no documents', async () => {
		cleanup = registerApi({ [`GET ${admin}`]: { body: { items: [] } } });
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.text()).toContain('No documents yet. Upload a draft to start.')
		);
	});
});

describe('admin trust page: uploading', () => {
	it('asks for a file before it sends anything', async () => {
		cleanup = registerApi({ [`GET ${admin}`]: { body: { items: [] } } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Upload a Draft'));
		await wrapper.find('form').trigger('submit');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toBe('Choose a file to upload.')
		);
		expect(count('POST', admin)).toBe(0);
	});

	it('sends the chosen file as base64 with its declared type, then reads the list again', async () => {
		cleanup = registerApi({
			[`POST ${admin}`]: { status: 201, body: draft },
			[`GET ${admin}`]: { body: { items: [] } }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('Upload a Draft'));

		await control(wrapper, 'Title').setValue('Conformance note');
		await control(wrapper, 'Version').setValue('2026.2');
		await control(wrapper, 'File Type').setValue('text/plain');
		const input = wrapper.find('input[type="file"]');
		Object.defineProperty(input.element, 'files', {
			value: [new File(['Conforms in part.'], 'note.txt', { type: 'text/plain' })]
		});
		await input.trigger('change');
		await wrapper.find('form').trigger('submit');

		await vi.waitFor(() => expect(count('POST', admin)).toBe(1));
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
			title: 'Conformance note',
			kind: 'hecvat',
			version: '2026.2',
			contentType: 'text/plain',
			contentBase64: Buffer.from('Conforms in part.').toString('base64')
		});
		await vi.waitFor(() => expect(count('GET', admin)).toBe(2));
	});
});

describe('admin trust page: publishing and retiring', () => {
	it('publishes a draft and reads the list again', async () => {
		cleanup = registerApi({
			[`GET ${admin}`]: { body: { items: [draft] } },
			[`POST ${admin}/doc_2/publish`]: {
				body: { ...draft, publishedAt: '2026-11-02T00:00:00.000Z' }
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain(draft.title));
		const publish = wrapper
			.findAll('button')
			.find((b) => b.text() === `Publish ${draft.title}`);
		await publish?.trigger('click');
		await vi.waitFor(() => expect(count('POST', `${admin}/doc_2/publish`)).toBe(1));
		await vi.waitFor(() => expect(count('GET', admin)).toBe(2));
	});

	it('shows the server answer when a publish is refused', async () => {
		cleanup = registerApi({
			[`GET ${admin}`]: { body: { items: [live] } },
			[`POST ${admin}/doc_1/retire`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Only a published document can be retired',
					details: {},
					requestId: 'req_1'
				}
			}
		});
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain(live.title));
		await wrapper
			.findAll('button')
			.find((b) => b.text() === `Retire ${live.title}`)
			?.trigger('click');
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toBe(
				'Only a published document can be retired'
			)
		);
	});
});
