import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../../contracts/src/common';
import { ensureCollegeDB } from '../../../src/server/db/collegedb';
import {
	listAllDocuments,
	listPublishedDocuments,
	openPublishedDocument,
	publishDocument,
	retireDocument,
	uploadDocument,
	type TrustBlobs,
	type TrustServices
} from '../../../src/server/services/trust';
import { TRUST_MAX_BYTES, trustUploadSchema, type TrustUpload } from '../../../src/shared/trust';
import { openBindings, type Bindings, type OpenBindings } from '../support';

let open: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	open = await openBindings();
	env = open.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => open.close());

function memoryBlobs() {
	const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
	const blobs: TrustBlobs = {
		async put(key, bytes, contentType) {
			objects.set(key, { bytes, contentType });
		},
		async open(key) {
			const object = objects.get(key);
			return object ? new Response(object.bytes).body : null;
		}
	};
	return { blobs, objects };
}

let clock = 1_000;

function services(): {
	deps: TrustServices;
	objects: Map<string, { bytes: Uint8Array; contentType: string }>;
} {
	const { blobs, objects } = memoryBlobs();
	return {
		objects,
		deps: { getDb: async () => db, blobs, newId: () => crypto.randomUUID(), now: () => ++clock }
	};
}

function upload(text: string, overrides: Partial<TrustUpload> = {}): TrustUpload {
	return {
		title: 'Security Packet',
		kind: 'hecvat',
		version: '4.0',
		contentType: 'text/plain',
		contentBase64: Buffer.from(text).toString('base64'),
		...overrides
	};
}

const actorOf = (label: string) => `user:${label}`;

async function auditActions(target: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		'SELECT action FROM platform_audit WHERE target = ? ORDER BY id'
	)
		.bind(target)
		.all<{ action: string }>();
	return results.map((row) => row.action);
}

describe('trust documents', () => {
	it('keeps a draft off the public list until it is published, and hides it again once retired', async () => {
		const { deps } = services();
		const draft = await uploadDocument(deps, actorOf('admin-a'), upload('draft body'));
		expect((await listPublishedDocuments(deps)).some((d) => d.id === draft.id)).toBe(false);

		await publishDocument(deps, actorOf('admin-a'), draft.id);
		expect((await listPublishedDocuments(deps)).some((d) => d.id === draft.id)).toBe(true);

		await retireDocument(deps, actorOf('admin-a'), draft.id);
		expect((await listPublishedDocuments(deps)).some((d) => d.id === draft.id)).toBe(false);
		expect((await listAllDocuments(deps)).some((d) => d.id === draft.id)).toBe(true);
	});

	it('stores the sha256 and size of the decoded bytes', async () => {
		const { deps } = services();
		const view = await uploadDocument(deps, actorOf('admin-a'), upload('hello world'));
		expect(view.sizeBytes).toBe(11);
		expect(view.sha256).toBe(await sha256Hex(new TextEncoder().encode('hello world')));
	});

	it('writes one platform audit row for each publish and each retire', async () => {
		const { deps } = services();
		const view = await uploadDocument(deps, actorOf('admin-b'), upload('audited'));
		await publishDocument(deps, actorOf('admin-b'), view.id);
		await retireDocument(deps, actorOf('admin-b'), view.id);
		expect(await auditActions(view.id)).toEqual([
			'trust.document.publish',
			'trust.document.retire'
		]);
	});

	it('refuses to publish twice or to retire a draft', async () => {
		const { deps } = services();
		const view = await uploadDocument(deps, actorOf('admin-c'), upload('once'));
		await expect(retireDocument(deps, actorOf('admin-c'), view.id)).rejects.toMatchObject({
			code: 'conflict'
		});
		await publishDocument(deps, actorOf('admin-c'), view.id);
		await expect(publishDocument(deps, actorOf('admin-c'), view.id)).rejects.toMatchObject({
			code: 'conflict'
		});
	});

	it('streams only a published document, from the key the table holds', async () => {
		const { deps, objects } = services();
		const view = await uploadDocument(deps, actorOf('admin-d'), upload('served'));
		await expect(openPublishedDocument(deps, view.id)).rejects.toMatchObject({
			code: 'not_found'
		});

		await publishDocument(deps, actorOf('admin-d'), view.id);
		const served = await openPublishedDocument(deps, view.id);
		expect(served.contentType).toBe('text/plain');
		expect(served.filename).toBe('security-packet-4-0.txt');
		expect(objects.has(`trust/${view.id}`)).toBe(true);

		await retireDocument(deps, actorOf('admin-d'), view.id);
		await expect(openPublishedDocument(deps, view.id)).rejects.toMatchObject({
			code: 'not_found'
		});
	});

	it('answers not found for an id the table does not hold, including path tricks', async () => {
		const { deps } = services();
		for (const id of ['doc_missing', '../trust/doc_missing', '..%2Fsecret']) {
			await expect(openPublishedDocument(deps, id)).rejects.toMatchObject({
				code: 'not_found'
			});
		}
	});

	it('keeps path characters out of the download filename', async () => {
		const { deps } = services();
		const view = await uploadDocument(
			deps,
			actorOf('admin-e'),
			upload('x', { title: '../../etc/passwd', contentType: 'text/markdown', kind: 'policy' })
		);
		await publishDocument(deps, actorOf('admin-e'), view.id);
		const served = await openPublishedDocument(deps, view.id);
		expect(served.filename).toMatch(/^[a-z0-9-]+\.md$/);
		expect(served.filename).not.toContain('/');
	});

	it('refuses an empty file, a file over the cap and bytes that are not base64', async () => {
		const { deps } = services();
		await expect(uploadDocument(deps, actorOf('x'), upload(''))).rejects.toMatchObject({
			code: 'validation'
		});
		const big = Buffer.alloc(TRUST_MAX_BYTES + 1, 'a').toString('base64');
		await expect(
			uploadDocument(deps, actorOf('x'), upload('', { contentBase64: big }))
		).rejects.toMatchObject({ code: 'validation' });
		await expect(
			uploadDocument(deps, actorOf('x'), upload('', { contentBase64: '!!not base64!!' }))
		).rejects.toMatchObject({ code: 'validation' });
	});

	it('accepts only the listed content types and kinds', () => {
		const base = { title: 'T', version: '1', contentBase64: 'YQ==' };
		expect(
			trustUploadSchema.safeParse({ ...base, kind: 'dpa', contentType: 'application/pdf' })
				.success
		).toBe(true);
		expect(
			trustUploadSchema.safeParse({ ...base, kind: 'dpa', contentType: 'text/html' }).success
		).toBe(false);
		expect(
			trustUploadSchema.safeParse({ ...base, kind: 'banner', contentType: 'text/plain' })
				.success
		).toBe(false);
	});
});
