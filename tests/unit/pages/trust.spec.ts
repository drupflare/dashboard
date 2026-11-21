import { mountSuspended } from '@nuxt/test-utils/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TrustPage from '~/pages/trust.vue';
import {
	DATA_LOCATION_STATEMENT,
	LIMITATIONS,
	SUBPROCESSORS,
	type TrustDocumentView
} from '~/shared/trust';
import { useTrustStore } from '~/stores/trust';
import { clearBrowserState, failure, registerApi } from '../stores/store-support';

const published: TrustDocumentView = {
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

let cleanup: () => void = () => undefined;
const mounted: { unmount: () => void }[] = [];

async function mountPage() {
	const wrapper = await mountSuspended(TrustPage, { route: '/trust' });
	mounted.push(wrapper);
	return wrapper;
}

beforeEach(() => {
	clearBrowserState();
	useTrustStore().$reset();
});

afterEach(() => {
	mounted.splice(0).forEach((wrapper) => wrapper.unmount());
	cleanup();
});

describe('trust center page', () => {
	it('names every subprocessor, the documented limits and the data location statement', async () => {
		cleanup = registerApi({ 'GET /api/v1/trust/documents': { body: { items: [] } } });
		const wrapper = await mountPage();
		for (const subprocessor of SUBPROCESSORS) {
			expect(wrapper.text()).toContain(subprocessor.name);
		}
		for (const limit of LIMITATIONS) {
			expect(wrapper.text()).toContain(limit);
		}
		expect(wrapper.text()).toContain(DATA_LOCATION_STATEMENT);
	});

	it('lists each published document with its hash and a download link', async () => {
		cleanup = registerApi({
			'GET /api/v1/trust/documents': { body: { items: [published] } }
		});
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.find('a[href="/api/v1/trust/documents/doc_1/download"]').exists()).toBe(
				true
			)
		);
		expect(wrapper.text()).toContain(published.title);
		expect(wrapper.text()).toContain(`SHA-256 ${published.sha256}`);
		expect(wrapper.find('a[href="/api/v1/trust/documents/doc_1/download"]').text()).toBe(
			`Download ${published.title}`
		);
	});

	it('says no documents are published when the list is empty', async () => {
		cleanup = registerApi({ 'GET /api/v1/trust/documents': { body: { items: [] } } });
		const wrapper = await mountPage();
		await vi.waitFor(() => expect(wrapper.text()).toContain('No documents are published yet.'));
	});

	it('says the documents could not be loaded when the list fails', async () => {
		cleanup = registerApi({
			'GET /api/v1/trust/documents': failure('internal', 'Something broke', 'req_1')
		});
		const wrapper = await mountPage();
		await vi.waitFor(() =>
			expect(wrapper.find('[role="alert"]').text()).toContain(
				'The documents could not be loaded.'
			)
		);
	});
});
