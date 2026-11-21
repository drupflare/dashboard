import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';
import type { ABUSE_SOURCES, ABUSE_STATES } from '../schema';
import type { Page } from './admin';

export type AbuseSource = (typeof ABUSE_SOURCES)[number];
export type AbuseState = (typeof ABUSE_STATES)[number];

export interface AbuseReport {
	id: string;
	siteId: string;
	organizationId: string;
	source: AbuseSource;
	reason: string;
	state: AbuseState;
	reviewer: string | null;
	notes: string | null;
	createdAt: number;
	updatedAt: number;
}

interface AbuseRow {
	id: string;
	site_id: string;
	organization_id: string;
	source: AbuseSource;
	reason: string;
	state: AbuseState;
	reviewer: string | null;
	notes: string | null;
	created_at: number;
	updated_at: number;
}

const NEWEST = Number.MAX_SAFE_INTEGER;

const COLUMNS =
	'id, site_id, organization_id, source, reason, state, reviewer, notes, created_at, updated_at';

function toReport(row: AbuseRow): AbuseReport {
	return {
		id: row.id,
		siteId: row.site_id,
		organizationId: row.organization_id,
		source: row.source,
		reason: row.reason,
		state: row.state,
		reviewer: row.reviewer,
		notes: row.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

// newest first; the reports sit on the directory shard, so one query answers the page
export async function listAbuseReports(
	db: CollegeDBClient,
	options: { state?: AbuseState; before?: number; limit: number }
): Promise<Page<AbuseReport>> {
	const state = options.state ?? null;
	const { results } = await db.all<AbuseRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM abuse_reports
		 WHERE created_at < ? AND (? IS NULL OR state = ?)
		 ORDER BY created_at DESC LIMIT ?`,
		[options.before ?? NEWEST, state, state, options.limit + 1]
	);
	const items = results.slice(0, options.limit).map(toReport);
	const more = results.length > options.limit;
	return { items, nextBefore: more ? (items[items.length - 1]?.createdAt ?? null) : null };
}

export async function getAbuseReport(db: CollegeDBClient, id: string): Promise<AbuseReport | null> {
	const row = await db.first<AbuseRow>(
		DIRECTORY_KEY,
		`SELECT ${COLUMNS} FROM abuse_reports WHERE id = ?`,
		[id]
	);
	return row ? toReport(row) : null;
}

export async function insertAbuseReport(
	db: CollegeDBClient,
	input: {
		id: string;
		siteId: string;
		organizationId: string;
		source: AbuseSource;
		reason: string;
		now: number;
	}
): Promise<AbuseReport> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO abuse_reports (${COLUMNS}) VALUES (?, ?, ?, ?, ?, 'open', NULL, NULL, ?, ?)`,
		[
			input.id,
			input.siteId,
			input.organizationId,
			input.source,
			input.reason,
			input.now,
			input.now
		]
	);
	return (await getAbuseReport(db, input.id)) as AbuseReport;
}

export async function setAbuseState(
	db: CollegeDBClient,
	input: { id: string; state: AbuseState; reviewer: string; notes: string | null; now: number }
): Promise<AbuseReport> {
	await db.run(
		DIRECTORY_KEY,
		'UPDATE abuse_reports SET state = ?, reviewer = ?, notes = ?, updated_at = ? WHERE id = ?',
		[input.state, input.reviewer, input.notes, input.now, input.id]
	);
	return (await getAbuseReport(db, input.id)) as AbuseReport;
}

export async function countOpenAbuse(db: CollegeDBClient): Promise<number> {
	const row = await db.first<{ n: number }>(
		DIRECTORY_KEY,
		"SELECT COUNT(*) AS n FROM abuse_reports WHERE state IN ('open', 'reviewing')"
	);
	return row?.n ?? 0;
}
