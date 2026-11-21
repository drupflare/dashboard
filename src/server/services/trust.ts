import { sha256Hex } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import {
	TRUST_CONTENT_TYPES,
	TRUST_MAX_BYTES,
	type TrustContentType,
	type TrustDocumentView,
	type TrustUpload
} from '../../shared/trust';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import {
	getTrustDocument,
	insertTrustDocument,
	listTrustDocuments,
	publishTrustDocument,
	retireTrustDocument,
	type TrustDocumentRow
} from '../db/repos/trust';

// #region collaborators

export interface TrustBlobs {
	put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
	open(key: string): Promise<ReadableStream | null>;
}

export interface TrustServices {
	getDb: () => Promise<CollegeDBClient>;
	blobs: TrustBlobs;
	newId: () => string;
	now: () => number;
}

let installed: TrustServices | null = null;

export function setTrustServices(services: TrustServices | null): void {
	installed = services;
}

export function trustServices(): TrustServices {
	if (installed === null)
		throw new ApiError('not_built', 'The trust center is not available yet');
	return installed;
}

// #endregion

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function viewOf(row: TrustDocumentRow): TrustDocumentView {
	return {
		id: row.id,
		title: row.title,
		kind: row.kind,
		version: row.version,
		contentType: row.contentType,
		sizeBytes: row.sizeBytes,
		sha256: row.sha256,
		publishedAt: iso(row.publishedAt),
		retiredAt: iso(row.retiredAt)
	};
}

export async function listPublishedDocuments(deps: TrustServices): Promise<TrustDocumentView[]> {
	const rows = await listTrustDocuments(await deps.getDb(), { publishedOnly: true });
	return rows.map(viewOf);
}

export async function listAllDocuments(deps: TrustServices): Promise<TrustDocumentView[]> {
	const rows = await listTrustDocuments(await deps.getDb(), { publishedOnly: false });
	return rows.map(viewOf);
}

function decodeBase64(text: string): Uint8Array {
	try {
		return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
	} catch {
		throw new ApiError('validation', 'The file is not valid base64');
	}
}

export async function uploadDocument(
	deps: TrustServices,
	actor: string,
	body: TrustUpload
): Promise<TrustDocumentView> {
	const bytes = decodeBase64(body.contentBase64);
	if (bytes.byteLength === 0) throw new ApiError('validation', 'The file is empty');
	if (bytes.byteLength > TRUST_MAX_BYTES) {
		throw new ApiError('validation', 'The file is larger than 10 MB');
	}
	const id = `doc_${deps.newId()}`;
	const objectKey = `trust/${id}`;
	await deps.blobs.put(objectKey, bytes, body.contentType);
	const row: TrustDocumentRow = {
		id,
		title: body.title,
		kind: body.kind,
		version: body.version,
		objectKey,
		contentType: body.contentType,
		sizeBytes: bytes.byteLength,
		sha256: await sha256Hex(bytes),
		publishedAt: null,
		retiredAt: null,
		createdAt: deps.now(),
		createdBy: actor
	};
	await insertTrustDocument(await deps.getDb(), row);
	return viewOf(row);
}

async function requireDocument(deps: TrustServices, id: string): Promise<TrustDocumentRow> {
	const row = await getTrustDocument(await deps.getDb(), id);
	if (row === null) throw new ApiError('not_found', 'Not found');
	return row;
}

export async function publishDocument(
	deps: TrustServices,
	actor: string,
	id: string
): Promise<TrustDocumentView> {
	const db = await deps.getDb();
	const row = await requireDocument(deps, id);
	const at = deps.now();
	if (!(await publishTrustDocument(db, id, at))) {
		throw new ApiError('conflict', 'Only a draft can be published');
	}
	await appendPlatformAudit(db, {
		actor,
		action: 'trust.document.publish',
		target: id,
		detail: { kind: row.kind, version: row.version, sha256: row.sha256 },
		now: at
	});
	return viewOf({ ...row, publishedAt: at });
}

export async function retireDocument(
	deps: TrustServices,
	actor: string,
	id: string
): Promise<TrustDocumentView> {
	const db = await deps.getDb();
	const row = await requireDocument(deps, id);
	const at = deps.now();
	if (!(await retireTrustDocument(db, id, at))) {
		throw new ApiError('conflict', 'Only a published document can be retired');
	}
	await appendPlatformAudit(db, {
		actor,
		action: 'trust.document.retire',
		target: id,
		detail: { kind: row.kind, version: row.version, sha256: row.sha256 },
		now: at
	});
	return viewOf({ ...row, retiredAt: at });
}

// the key comes from the row, never from the request, and only a published document is served
export async function openPublishedDocument(
	deps: TrustServices,
	id: string
): Promise<{ stream: ReadableStream; filename: string; contentType: string }> {
	const row = await getTrustDocument(await deps.getDb(), id);
	if (row === null || row.publishedAt === null || row.retiredAt !== null) {
		throw new ApiError('not_found', 'Not found');
	}
	const stream = await deps.blobs.open(row.objectKey);
	if (stream === null) throw new ApiError('not_found', 'Not found');
	const extension = TRUST_CONTENT_TYPES[row.contentType as TrustContentType];
	const slug = `${row.title}-${row.version}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return {
		stream,
		filename: `${slug || 'document'}.${extension}`,
		contentType: row.contentType
	};
}
