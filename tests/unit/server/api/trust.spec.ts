import type { CollegeDBClient } from '@earth-app/collegedb';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import publish from '../../../../src/server/api/v1/admin/trust/documents/[id]/publish.post';
import retire from '../../../../src/server/api/v1/admin/trust/documents/[id]/retire.post';
import adminList from '../../../../src/server/api/v1/admin/trust/documents/index.get';
import adminUpload from '../../../../src/server/api/v1/admin/trust/documents/index.post';
import documentList from '../../../../src/server/api/v1/trust/documents.get';
import documentDownload from '../../../../src/server/api/v1/trust/documents/[id]/download.get';
import { SCHEMA_STATEMENTS } from '../../../../src/server/db/schema';
import { setTrustServices, type TrustServices } from '../../../../src/server/services/trust';
import { resetApiDeps } from '../../../../src/server/utils/define-api';
import { TRUST_MAX_BYTES } from '../../../../src/shared/trust';
import { admin, facts, fresh, member } from '../../domain/fixtures';
import { asUser, send, setup } from '../fixtures/harness';

const NOW = 1_800_000_000_000;
const UPLOAD = '/api/v1/admin/trust/documents';
const BODY = 'Conforms in part.';

function world() {
	const sql = new DatabaseSync(':memory:');
	for (const statement of SCHEMA_STATEMENTS) sql.exec(statement);
	const db = {
		async first(_key: string, text: string, bindings: unknown[] = []) {
			return sql.prepare(text).get(...(bindings as never[])) ?? null;
		},
		async all(_key: string, text: string, bindings: unknown[] = []) {
			return { results: sql.prepare(text).all(...(bindings as never[])) };
		},
		async run(_key: string, text: string, bindings: unknown[] = []) {
			const result = sql.prepare(text).run(...(bindings as never[]));
			return { meta: { changes: Number(result.changes) } };
		}
	} as unknown as CollegeDBClient;
	const stored = new Map<string, Uint8Array>();
	const opened: string[] = [];
	let counter = 0;
	const services: TrustServices = {
		getDb: async () => db,
		blobs: {
			async put(key, bytes) {
				stored.set(key, bytes);
			},
			async open(key) {
				opened.push(key);
				const bytes = stored.get(key);
				return bytes === undefined ? null : new Response(new Uint8Array(bytes)).body;
			}
		},
		newId: () => `${++counter}`,
		now: () => NOW
	};
	setTrustServices(services);
	return { sql, stored, opened };
}

const asAdmin = () => setup({ facts: () => facts({ ...admin, ...fresh }) });
const asOwner = () => setup({ facts: () => facts({ ...member('owner'), ...fresh }) });

const base64 = (text: string | Uint8Array) => Buffer.from(text).toString('base64');

const upload = (over: Record<string, unknown> = {}) =>
	send(adminUpload, UPLOAD, {
		method: 'POST',
		path: UPLOAD,
		headers: asUser,
		json: {
			title: 'Accessibility report',
			kind: 'vpat',
			version: '2026.1',
			contentType: 'text/plain',
			contentBase64: base64(BODY),
			...over
		}
	});

async function uploaded(over: Record<string, unknown> = {}): Promise<string> {
	return ((await upload(over)).json as { id: string }).id;
}

const publishDocument = (id: string) =>
	send(publish, '/api/v1/admin/trust/documents/:id/publish', {
		method: 'POST',
		path: `/api/v1/admin/trust/documents/${id}/publish`,
		headers: asUser,
		json: {}
	});

const retireDocument = (id: string) =>
	send(retire, '/api/v1/admin/trust/documents/:id/retire', {
		method: 'POST',
		path: `/api/v1/admin/trust/documents/${id}/retire`,
		headers: asUser,
		json: {}
	});

const publicList = () =>
	send(documentList, '/api/v1/trust/documents', { path: '/api/v1/trust/documents' });

const download = (id: string, query = '') =>
	send(documentDownload, '/api/v1/trust/documents/:id/download', {
		path: `/api/v1/trust/documents/${id}/download${query}`
	});

afterEach(() => {
	setTrustServices(null);
	resetApiDeps();
});

beforeEach(() => {
	resetApiDeps();
	world();
});

describe('public trust list', () => {
	it('lists only the published documents, not drafts or retired ones', async () => {
		asAdmin();
		await uploaded({ title: 'Draft policy' });
		const live = await uploaded({ title: 'Live report' });
		const old = await uploaded({ title: 'Old report' });
		await publishDocument(live);
		await publishDocument(old);
		await retireDocument(old);

		const reply = await publicList();
		expect(reply.status).toBe(200);
		expect(reply.headers.get('cache-control')).toBe('public, max-age=300');
		expect((reply.json as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([
			live
		]);
	});
});

describe('public download', () => {
	it('serves a published document as an attachment, from the key stored on its row', async () => {
		const w = world();
		asAdmin();
		const id = await uploaded();
		await publishDocument(id);

		const reply = await download(id, '?key=trust/some-other-file');
		expect(reply.status).toBe(200);
		expect(reply.text).toBe(BODY);
		expect(reply.headers.get('content-disposition')).toBe(
			'attachment; filename="accessibility-report-2026-1.txt"'
		);
		expect(reply.headers.get('x-content-type-options')).toBe('nosniff');
		expect(w.opened).toEqual([`trust/${id}`]);
	});

	it('answers not found for a draft, a retired document, an unknown id and a path trick, and opens no file', async () => {
		const w = world();
		asAdmin();
		const draft = await uploaded();
		const retired = await uploaded({ title: 'Retired' });
		await publishDocument(retired);
		await retireDocument(retired);

		for (const id of [draft, retired, 'doc_missing', '%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
			const reply = await download(id);
			expect(reply.status, id).toBe(404);
		}
		expect(w.opened).toEqual([]);
	});
});

describe('admin upload', () => {
	it('stores a draft with the hash and size of the decoded file', async () => {
		asAdmin();
		const reply = await upload();
		expect(reply.status).toBe(201);
		expect(reply.json).toMatchObject({
			title: 'Accessibility report',
			kind: 'vpat',
			version: '2026.1',
			contentType: 'text/plain',
			sizeBytes: Buffer.byteLength(BODY),
			sha256: createHash('sha256').update(BODY).digest('hex'),
			publishedAt: null,
			retiredAt: null
		});
	});

	it('refuses a file over 10 MB, measured after decoding', async () => {
		const w = world();
		setup({
			facts: () => facts({ ...admin, ...fresh }),
			deps: { maxBodyBytes: 16 * 1024 * 1024 }
		});
		const reply = await upload({
			contentBase64: base64(new Uint8Array(TRUST_MAX_BYTES + 1))
		});
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
		expect(w.stored.size).toBe(0);
	});

	it('refuses a content type that is not on the allow-list', async () => {
		const w = world();
		asAdmin();
		const reply = await upload({ contentType: 'text/html' });
		expect(reply.status).toBe(400);
		expect(w.stored.size).toBe(0);
	});

	it('refuses text that is not base64', async () => {
		asAdmin();
		const reply = await upload({ contentBase64: '!!not-base64!!' });
		expect(reply.status).toBe(400);
		expect(reply.json).toMatchObject({ code: 'validation' });
	});
});

describe('admin trust routes: who gets in', () => {
	it('refuses an organisation owner with no platform role, on every admin trust route', async () => {
		asAdmin();
		const id = await uploaded();
		asOwner();

		expect((await upload()).status).toBe(403);
		expect(
			(
				await send(adminList, '/api/v1/admin/trust/documents', {
					path: '/api/v1/admin/trust/documents',
					headers: asUser
				})
			).status
		).toBe(403);
		expect((await publishDocument(id)).status).toBe(403);
		expect((await retireDocument(id)).status).toBe(403);
		expect((await publicList()).json).toEqual({ items: [] });
	});

	it('refuses a publish or retire until the admin has signed in again', async () => {
		asAdmin();
		const id = await uploaded();
		setup({ facts: () => facts({ ...admin }) });
		expect((await publishDocument(id)).status).toBe(403);
		expect((await retireDocument(id)).status).toBe(403);
	});
});

describe('publish and retire', () => {
	it('publishes a draft once, retires it once, and writes both to the platform audit log', async () => {
		const w = world();
		asAdmin();
		const id = await uploaded();

		const published = await publishDocument(id);
		expect(published.status).toBe(200);
		expect(published.json).toMatchObject({ id, publishedAt: new Date(NOW).toISOString() });
		expect((await publishDocument(id)).status).toBe(409);

		const retired = await retireDocument(id);
		expect(retired.status).toBe(200);
		expect(retired.json).toMatchObject({ retiredAt: new Date(NOW).toISOString() });
		expect((await retireDocument(id)).status).toBe(409);

		expect(
			w.sql.prepare('SELECT action, target FROM platform_audit ORDER BY action').all()
		).toEqual([
			{ action: 'trust.document.publish', target: id },
			{ action: 'trust.document.retire', target: id }
		]);
	});

	it('answers not found for an id that is not a document', async () => {
		asAdmin();
		expect((await publishDocument('doc_nope')).status).toBe(404);
	});
});
