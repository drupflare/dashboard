import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	ESTATE_SQL,
	likeOf,
	toAssessmentRecord,
	toRowRecord,
	type AssessmentDbRow,
	type AssessmentRecord,
	type EstateRowDb,
	type EstateRowRecord
} from '../../../shared/estate-sql';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';

export interface NewAssessment {
	organizationId: string;
	id: string;
	operationId: string;
	idempotencyKey: string;
	rowCount: number;
	rejectedTotal: number;
	access: string;
	createdBy: string;
	now: number;
}

export interface NewAssessmentRow {
	number: number;
	hostname: string;
	state: 'pending' | 'needs proof';
	class: string | null;
	site: string;
	verdict: string | null;
	needsProof: string | null;
}

// the rows go in beside the assessment; a repeat of the same key is caught by the unique index
export async function insertAssessment(
	db: CollegeDBClient,
	input: NewAssessment,
	rows: readonly NewAssessmentRow[]
): Promise<void> {
	const org = input.organizationId;
	await uniqueOrDuplicate(() =>
		db.run(org, ESTATE_SQL.insertAssessment, [
			org,
			input.id,
			input.operationId,
			input.idempotencyKey,
			input.rowCount,
			input.rejectedTotal,
			input.access,
			input.createdBy,
			input.now,
			input.now
		])
	);
	for (const row of rows) {
		await db.run(org, ESTATE_SQL.insertRow, [
			org,
			input.id,
			row.number,
			row.hostname,
			row.state,
			row.class,
			row.site,
			row.verdict,
			row.needsProof,
			input.now
		]);
	}
}

export async function getAssessment(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<AssessmentRecord | null> {
	const row = await db.first<AssessmentDbRow>(orgId, ESTATE_SQL.assessment, [orgId, id]);
	return row ? toAssessmentRecord(row) : null;
}

export async function getAssessmentByKey(
	db: CollegeDBClient,
	orgId: string,
	key: string
): Promise<AssessmentRecord | null> {
	const row = await db.first<AssessmentDbRow>(orgId, ESTATE_SQL.assessmentByKey, [orgId, key]);
	return row ? toAssessmentRecord(row) : null;
}

export async function listAssessments(
	db: CollegeDBClient,
	orgId: string,
	options: { before?: { createdAt: number; id: string }; count: number }
): Promise<AssessmentRecord[]> {
	const at = options.before?.createdAt ?? null;
	const { results } = await db.all<AssessmentDbRow>(orgId, ESTATE_SQL.listAssessments, [
		orgId,
		at,
		at,
		at,
		options.before?.id ?? null,
		options.count
	]);
	return results.map(toAssessmentRecord);
}

export async function countRows(
	db: CollegeDBClient,
	orgId: string,
	id: string
): Promise<{ state: string; class: string | null; n: number }[]> {
	const { results } = await db.all<{ state: string; class: string | null; n: number }>(
		orgId,
		ESTATE_SQL.counts,
		[orgId, id]
	);
	return results;
}

export interface RowFilter {
	class?: string;
	state?: string;
	text?: string;
}

export async function pageRows(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	options: { after: number; count: number; filter?: RowFilter }
): Promise<EstateRowRecord[]> {
	const f = options.filter ?? {};
	const cls = f.class ?? null;
	const state = f.state ?? null;
	const like = f.text === undefined || f.text === '' ? null : likeOf(f.text.toLowerCase());
	const { results } = await db.all<EstateRowDb>(orgId, ESTATE_SQL.page, [
		orgId,
		id,
		options.after,
		cls,
		cls,
		state,
		state,
		like,
		like,
		options.count
	]);
	return results.map(toRowRecord);
}

// true when this call moved a still-open assessment to cancelled
export async function cancelAssessment(
	db: CollegeDBClient,
	orgId: string,
	id: string,
	now: number
): Promise<boolean> {
	return wasChanged(await db.run(orgId, ESTATE_SQL.cancel, [now, orgId, id]));
}

export async function provenDomains(db: CollegeDBClient, orgId: string): Promise<Set<string>> {
	const { results } = await db.all<{ domain: string }>(orgId, ESTATE_SQL.proofs, [orgId]);
	return new Set(results.map((row) => row.domain));
}

export async function recordProof(
	db: CollegeDBClient,
	orgId: string,
	domain: string,
	method: 'dns' | 'http',
	now: number
): Promise<void> {
	await db.run(orgId, ESTATE_SQL.proveDomain, [orgId, domain, method, now]);
}
