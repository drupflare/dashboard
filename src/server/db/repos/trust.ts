import type { CollegeDBClient } from '@earth-app/collegedb';
import type { TrustDocumentKind } from '../../../shared/trust';
import { DIRECTORY_KEY, wasChanged } from '../collegedb';

export interface TrustDocumentRow {
	id: string;
	title: string;
	kind: TrustDocumentKind;
	version: string;
	objectKey: string;
	contentType: string;
	sizeBytes: number;
	sha256: string;
	publishedAt: number | null;
	retiredAt: number | null;
	createdAt: number;
	createdBy: string;
}

interface TrustDocumentDb {
	id: string;
	title: string;
	kind: TrustDocumentKind;
	version: string;
	object_key: string;
	content_type: string;
	size_bytes: number;
	sha256: string;
	published_at: number | null;
	retired_at: number | null;
	created_at: number;
	created_by: string;
}

const COLUMNS =
	'id, title, kind, version, object_key, content_type, size_bytes, sha256, published_at, retired_at, created_at, created_by';

function toRow(row: TrustDocumentDb): TrustDocumentRow {
	return {
		id: row.id,
		title: row.title,
		kind: row.kind,
		version: row.version,
		objectKey: row.object_key,
		contentType: row.content_type,
		sizeBytes: row.size_bytes,
		sha256: row.sha256,
		publishedAt: row.published_at,
		retiredAt: row.retired_at,
		createdAt: row.created_at,
		createdBy: row.created_by
	};
}

export async function listTrustDocuments(
	db: CollegeDBClient,
	options: { publishedOnly: boolean }
): Promise<TrustDocumentRow[]> {
	const filter = options.publishedOnly
		? 'WHERE published_at IS NOT NULL AND retired_at IS NULL'
		: '';
	const { results } = await db.all<TrustDocumentDb>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM trust_documents ${filter} ORDER BY kind, title, id`,
		[]
	);
	return results.map(toRow);
}

export async function getTrustDocument(
	db: CollegeDBClient,
	id: string
): Promise<TrustDocumentRow | null> {
	const row = await db.first<TrustDocumentDb>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM trust_documents WHERE id = ?`,
		[id]
	);
	return row ? toRow(row) : null;
}

export async function insertTrustDocument(
	db: CollegeDBClient,
	row: TrustDocumentRow
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO trust_documents (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.title,
			row.kind,
			row.version,
			row.objectKey,
			row.contentType,
			row.sizeBytes,
			row.sha256,
			row.publishedAt,
			row.retiredAt,
			row.createdAt,
			row.createdBy
		]
	);
}

// a draft only: a published or retired document is not republished, so the public list never flips back
export async function publishTrustDocument(
	db: CollegeDBClient,
	id: string,
	at: number
): Promise<boolean> {
	return wasChanged(
		await db.run(
			DIRECTORY_KEY,
			'UPDATE trust_documents SET published_at = ? WHERE id = ? AND published_at IS NULL AND retired_at IS NULL',
			[at, id]
		)
	);
}

export async function retireTrustDocument(
	db: CollegeDBClient,
	id: string,
	at: number
): Promise<boolean> {
	return wasChanged(
		await db.run(
			DIRECTORY_KEY,
			'UPDATE trust_documents SET retired_at = ? WHERE id = ? AND retired_at IS NULL AND published_at IS NOT NULL',
			[at, id]
		)
	);
}
