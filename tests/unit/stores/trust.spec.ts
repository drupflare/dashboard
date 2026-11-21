import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrustDocumentView, TrustUpload } from '~/shared/trust';
import { useTrustStore } from '~/stores/trust';
import { calls, clearBrowserState, failure, registerApi } from './store-support';

const base = '/api/v1/trust/documents';
const admin = '/api/v1/admin/trust/documents';

const live: TrustDocumentView = {
	id: 'doc_1',
	title: 'Accessibility report',
	kind: 'vpat',
	version: '2026.1',
	contentType: 'application/pdf',
	sizeBytes: 1024,
	sha256: 'a'.repeat(64),
	publishedAt: '2026-11-01T00:00:00.000Z',
	retiredAt: null
};

const draft: TrustDocumentView = { ...live, id: 'doc_2', publishedAt: null };

const upload: TrustUpload = {
	title: 'Accessibility report',
	kind: 'vpat',
	version: '2026.2',
	contentType: 'application/pdf',
	contentBase64: 'AAAA'
};

let cleanup: () => void = () => undefined;

beforeEach(() => {
	clearBrowserState();
	useTrustStore().$reset();
});

afterEach(() => {
	cleanup();
});

const count = (method: string, path: string) =>
	calls.filter((call) => call.method === method && call.path === path).length;

describe('trust store: public documents', () => {
	it('loads the published documents once and reads them again only when forced', async () => {
		cleanup = registerApi({ [`GET ${base}`]: { body: { items: [live] } } });
		const store = useTrustStore();
		await store.loadPublished();
		await store.loadPublished();
		expect(count('GET', base)).toBe(1);
		expect(store.published).toEqual([live]);
		await store.loadPublished(true);
		expect(count('GET', base)).toBe(2);
	});

	it('keeps the error and leaves the list not loaded when the documents cannot be read', async () => {
		cleanup = registerApi({ [`GET ${base}`]: failure('internal', 'Something broke', 'req_1') });
		const store = useTrustStore();
		await store.loadPublished();
		expect(store.error).not.toBeNull();
		expect(store.published).toBeUndefined();
		expect(store.loading).toBe(false);
	});

	it('shows an empty list as loaded, not as missing', async () => {
		cleanup = registerApi({ [`GET ${base}`]: { body: { items: [] } } });
		const store = useTrustStore();
		await store.loadPublished();
		expect(store.published).toEqual([]);
	});
});

describe('trust store: admin documents', () => {
	it('loads every document, drafts and retired ones included', async () => {
		cleanup = registerApi({ [`GET ${admin}`]: { body: { items: [live, draft] } } });
		const store = useTrustStore();
		await store.loadAll();
		expect(store.documents).toEqual([live, draft]);
		expect(store.published).toBeUndefined();
	});

	it('uploads a draft, then reads the admin list again', async () => {
		cleanup = registerApi({
			[`POST ${admin}`]: { status: 201, body: draft },
			[`GET ${admin}`]: { body: { items: [draft] } }
		});
		expect(await useTrustStore().upload(upload)).toBe(true);
		expect(calls.find((call) => call.method === 'POST')?.body).toEqual(upload);
		expect(count('GET', admin)).toBe(1);
	});

	it('keeps the refusal of an upload and does not read the list again', async () => {
		cleanup = registerApi({
			[`POST ${admin}`]: {
				status: 400,
				body: {
					code: 'validation',
					message: 'The file is larger than 10 MB',
					details: {},
					requestId: 'req_2'
				}
			}
		});
		const store = useTrustStore();
		expect(await store.upload(upload)).toBe(false);
		expect(store.saveError?.message).toBe('The file is larger than 10 MB');
		expect(store.saving).toBe(false);
		expect(count('GET', admin)).toBe(0);
	});

	it('publishes and retires one document by its id, then reads the list again', async () => {
		cleanup = registerApi({
			[`POST ${admin}/doc_2/publish`]: {
				body: { ...draft, publishedAt: '2026-11-02T00:00:00.000Z' }
			},
			[`POST ${admin}/doc_1/retire`]: {
				body: { ...live, retiredAt: '2026-11-02T00:00:00.000Z' }
			},
			[`GET ${admin}`]: { body: { items: [] } }
		});
		const store = useTrustStore();
		expect(await store.act('doc_2', 'publish')).toBe(true);
		expect(await store.act('doc_1', 'retire')).toBe(true);
		expect(count('POST', `${admin}/doc_2/publish`)).toBe(1);
		expect(count('POST', `${admin}/doc_1/retire`)).toBe(1);
		expect(count('GET', admin)).toBe(2);
	});

	it('keeps the refusal of a publish, so the page can say why', async () => {
		cleanup = registerApi({
			[`POST ${admin}/doc_2/publish`]: {
				status: 409,
				body: {
					code: 'conflict',
					message: 'Only a draft can be published',
					details: {},
					requestId: 'req_3'
				}
			}
		});
		const store = useTrustStore();
		expect(await store.act('doc_2', 'publish')).toBe(false);
		expect(store.saveError?.message).toBe('Only a draft can be published');
	});
});
