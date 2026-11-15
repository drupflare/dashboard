import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';

export type TemplateBundleStatus = 'building' | 'ready' | 'failed';

export interface TemplateBundleRecord {
	id: string;
	entryId: string;
	commit: string;
	status: TemplateBundleStatus;
	bundleKey: string | null;
	manifest: string | null;
	failure: string | null;
	createdAt: number;
}

interface TemplateBundleRow {
	id: string;
	entry_id: string;
	commit_sha: string;
	status: TemplateBundleStatus;
	bundle_key: string | null;
	manifest: string | null;
	failure: string | null;
	created_at: number;
}

const COLUMNS = 'id, entry_id, commit_sha, status, bundle_key, manifest, failure, created_at';

export const toTemplateBundle = (row: TemplateBundleRow): TemplateBundleRecord => ({
	id: row.id,
	entryId: row.entry_id,
	commit: row.commit_sha,
	status: row.status,
	bundleKey: row.bundle_key,
	manifest: row.manifest,
	failure: row.failure,
	createdAt: row.created_at
});

// template bundles belong to the platform, so they share the directory shard
export async function beginTemplateBuild(
	db: CollegeDBClient,
	row: { id: string; entryId: string; commit: string; now: number }
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO template_bundles (${COLUMNS}) VALUES (?, ?, ?, 'building', NULL, NULL, NULL, ?)`,
		[row.id, row.entryId, row.commit, row.now]
	);
}

// the newest row per entry, whatever its state
export async function latestTemplateBundles(
	db: CollegeDBClient
): Promise<Map<string, TemplateBundleRecord>> {
	const { results } = await db.all<TemplateBundleRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM template_bundles ORDER BY created_at ASC, id ASC`
	);
	const latest = new Map<string, TemplateBundleRecord>();
	for (const row of results) latest.set(row.entry_id, toTemplateBundle(row));
	return latest;
}

// a create may use only a build that finished, at the commit the corpus pins now
export async function getReadyTemplateBundle(
	db: CollegeDBClient,
	entryId: string,
	commit: string
): Promise<TemplateBundleRecord | null> {
	const row = await db.first<TemplateBundleRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM template_bundles
		 WHERE entry_id = ? AND commit_sha = ? AND status = 'ready'
		 ORDER BY created_at DESC, id DESC LIMIT 1`,
		[entryId, commit]
	);
	return row ? toTemplateBundle(row) : null;
}

// a build whose workflow died stays 'building', so only a recent one blocks the next
export async function hasOpenTemplateBuild(
	db: CollegeDBClient,
	entryId: string,
	notBefore: number
): Promise<boolean> {
	const row = await db.first<{ n: number }>(
		DIRECTORY_KEY,
		`SELECT COUNT(*) AS n FROM template_bundles
		 WHERE entry_id = ? AND status = 'building' AND created_at >= ?`,
		[entryId, notBefore]
	);
	return (row?.n ?? 0) > 0;
}

export async function failTemplateBuild(
	db: CollegeDBClient,
	id: string,
	failure: string
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`UPDATE template_bundles SET status = 'failed', failure = ? WHERE id = ? AND status = 'building'`,
		[failure, id]
	);
}
