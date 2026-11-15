import type { ReleaseManifest } from '@contracts/releases';
import { RELEASE_KINDS } from '@contracts/releases';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';

export type ReleaseKind = (typeof RELEASE_KINDS)[number];

export interface ReleaseRecord {
	id: string;
	kind: ReleaseKind;
	version: string;
	manifestDigest: string;
	schemaVersion: number;
	acceptsSchema: number;
	publishedAt: number;
	advisoryAt: number | null;
	createdAt: number;
}

interface ReleaseRow {
	id: string;
	kind: ReleaseKind;
	version: string;
	manifest_digest: string;
	schema_version: number;
	accepts_schema: number;
	published_at: number;
	advisory_at: number | null;
	created_at: number;
}

export interface NewRelease {
	id: string;
	kind: ReleaseManifest['kind'];
	version: string;
	manifestDigest: string;
	schemaVersion: number;
	acceptsSchema: number;
	publishedAt: number;
	advisoryAt?: number | null;
	now: number;
}

const COLUMNS = `id, kind, version, manifest_digest, schema_version, accepts_schema, published_at,
	advisory_at, created_at`;

const toRecord = (row: ReleaseRow): ReleaseRecord => ({
	id: row.id,
	kind: row.kind,
	version: row.version,
	manifestDigest: row.manifest_digest,
	schemaVersion: row.schema_version,
	acceptsSchema: row.accepts_schema,
	publishedAt: row.published_at,
	advisoryAt: row.advisory_at,
	createdAt: row.created_at
});

// releases are platform-wide, so they share the directory shard; the sites that run them live on
// organisation shards and are matched in the engine's own database
export async function getRelease(db: CollegeDBClient, id: string): Promise<ReleaseRecord | null> {
	const row = await db.first<ReleaseRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM releases WHERE id = ?`,
		[id]
	);
	return row ? toRecord(row) : null;
}

export async function getReleaseByVersion(
	db: CollegeDBClient,
	kind: ReleaseKind,
	version: string
): Promise<ReleaseRecord | null> {
	const row = await db.first<ReleaseRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM releases WHERE kind = ? AND version = ?`,
		[kind, version]
	);
	return row ? toRecord(row) : null;
}

// a repeat of a kind and version returns the row already stored and changes nothing
export async function registerRelease(
	db: CollegeDBClient,
	release: NewRelease
): Promise<{ release: ReleaseRecord; created: boolean }> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT OR IGNORE INTO releases (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			release.id,
			release.kind,
			release.version,
			release.manifestDigest,
			release.schemaVersion,
			release.acceptsSchema,
			release.publishedAt,
			release.advisoryAt ?? null,
			release.now
		]
	);
	const stored = await getReleaseByVersion(db, release.kind, release.version);
	if (stored === null) throw new Error('the release is missing after the insert');
	return { release: stored, created: stored.id === release.id };
}

// newest first by publish time, id as the tie break
export async function listReleases(
	db: CollegeDBClient,
	kind: ReleaseKind,
	count: number
): Promise<ReleaseRecord[]> {
	const { results } = await db.all<ReleaseRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM releases WHERE kind = ?
		 ORDER BY published_at DESC, id DESC LIMIT ?`,
		[kind, count]
	);
	return results.map(toRecord);
}

export async function latestReleases(
	db: CollegeDBClient
): Promise<Partial<Record<ReleaseKind, ReleaseRecord>>> {
	const latest: Partial<Record<ReleaseKind, ReleaseRecord>> = {};
	for (const kind of RELEASE_KINDS) {
		const [first] = await listReleases(db, kind, 1);
		if (first !== undefined) latest[kind] = first;
	}
	return latest;
}
