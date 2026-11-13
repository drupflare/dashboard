import { ROW_CLASSES, ROW_STATES } from '@contracts/estate';

// the largest a stored row blob may be; each is a bounded record, not a free-form document
export const ESTATE_BLOB_BYTES = {
	site: 16_384,
	verdict: 8_192,
	access: 8_192,
	report: 4_096
} as const;

const quoted = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

export const ESTATE_SCHEMA_STATEMENTS: string[] = [
	`CREATE TABLE IF NOT EXISTS assessments (
	organization_id TEXT NOT NULL,
	id TEXT NOT NULL,
	operation_id TEXT NOT NULL,
	idempotency_key TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('preparing', 'running', 'finished', 'cancelled', 'failed')),
	row_count INTEGER NOT NULL CHECK (row_count >= 0),
	rejected_total INTEGER NOT NULL DEFAULT 0,
	access TEXT NOT NULL CHECK (length(access) <= ${ESTATE_BLOB_BYTES.access}),
	report TEXT CHECK (report IS NULL OR length(report) <= ${ESTATE_BLOB_BYTES.report}),
	created_by TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, id)
)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS assessments_operation ON assessments (operation_id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS assessments_idempotency ON assessments (organization_id, idempotency_key)`,
	`CREATE INDEX IF NOT EXISTS assessments_org ON assessments (organization_id, created_at, id)`,
	`CREATE TABLE IF NOT EXISTS assessment_rows (
	organization_id TEXT NOT NULL,
	assessment_id TEXT NOT NULL,
	number INTEGER NOT NULL CHECK (number >= 1),
	hostname TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quoted(ROW_STATES)})),
	class TEXT CHECK (class IS NULL OR class IN (${quoted(ROW_CLASSES)})),
	attempts INTEGER NOT NULL DEFAULT 0,
	site TEXT NOT NULL CHECK (length(site) <= ${ESTATE_BLOB_BYTES.site}),
	verdict TEXT CHECK (verdict IS NULL OR length(verdict) <= ${ESTATE_BLOB_BYTES.verdict}),
	needs_proof TEXT,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, assessment_id, number)
)`,
	`CREATE INDEX IF NOT EXISTS assessment_rows_state ON assessment_rows (organization_id, assessment_id, state, number)`,
	`CREATE TABLE IF NOT EXISTS assessment_proofs (
	organization_id TEXT NOT NULL,
	domain TEXT NOT NULL,
	method TEXT NOT NULL CHECK (method IN ('dns', 'http')),
	proven_at INTEGER NOT NULL,
	PRIMARY KEY (organization_id, domain)
)`
];

export const ESTATE_SQL = {
	insertAssessment: `INSERT INTO assessments (organization_id, id, operation_id, idempotency_key, state,
		row_count, rejected_total, access, created_by, created_at, updated_at)
		VALUES (?, ?, ?, ?, 'preparing', ?, ?, ?, ?, ?, ?)`,
	insertRow: `INSERT INTO assessment_rows (organization_id, assessment_id, number, hostname, state,
		class, site, verdict, needs_proof, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	assessment: `SELECT id, operation_id, state, row_count, rejected_total, access, report, created_by,
		created_at, updated_at FROM assessments WHERE organization_id = ? AND id = ?`,
	assessmentByKey: `SELECT id, operation_id, state, row_count, rejected_total, access, report,
		created_by, created_at, updated_at FROM assessments
		WHERE organization_id = ? AND idempotency_key = ?`,
	listAssessments: `SELECT id, operation_id, state, row_count, rejected_total, access, report,
		created_by, created_at, updated_at FROM assessments WHERE organization_id = ?
		AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
		ORDER BY created_at DESC, id DESC LIMIT ?`,
	cancel: `UPDATE assessments SET state = 'cancelled', updated_at = ?
		WHERE organization_id = ? AND id = ? AND state IN ('preparing', 'running')`,
	start: `UPDATE assessments SET state = 'running', updated_at = ?
		WHERE organization_id = ? AND id = ? AND state <> 'cancelled'`,
	finish: `UPDATE assessments SET state = ?, report = ?, updated_at = ?
		WHERE organization_id = ? AND id = ? AND state <> 'cancelled'`,
	counts: `SELECT state, class, COUNT(*) AS n FROM assessment_rows
		WHERE organization_id = ? AND assessment_id = ? GROUP BY state, class`,
	row: `SELECT number, hostname, state, class, attempts, site, verdict, needs_proof
		FROM assessment_rows WHERE organization_id = ? AND assessment_id = ? AND number = ?`,
	numbers: `SELECT number FROM assessment_rows WHERE organization_id = ? AND assessment_id = ?
		ORDER BY number`,
	page: `SELECT number, hostname, state, class, attempts, site, verdict, needs_proof
		FROM assessment_rows WHERE organization_id = ? AND assessment_id = ? AND number > ?
		AND (? IS NULL OR class = ?) AND (? IS NULL OR state = ?)
		AND (? IS NULL OR hostname LIKE ? ESCAPE '\\')
		ORDER BY number LIMIT ?`,
	begin: `UPDATE assessment_rows SET state = 'checking', attempts = attempts + 1, updated_at = ?
		WHERE organization_id = ? AND assessment_id = ? AND number = ?
		AND state IN ('pending', 'checking', 'could not check')`,
	finishRow: `UPDATE assessment_rows SET state = ?, class = ?, verdict = ?, updated_at = ?
		WHERE organization_id = ? AND assessment_id = ? AND number = ?
		AND state IN ('pending', 'checking', 'could not check')`,
	skip: `UPDATE assessment_rows SET state = 'skipped', updated_at = ?
		WHERE organization_id = ? AND assessment_id = ?
		AND state IN ('pending', 'checking', 'could not check')`,
	proofs: `SELECT domain FROM assessment_proofs WHERE organization_id = ?`,
	proveDomain: `INSERT INTO assessment_proofs (organization_id, domain, method, proven_at)
		VALUES (?, ?, ?, ?) ON CONFLICT (organization_id, domain) DO NOTHING`
} as const;

export interface AssessmentRecord {
	id: string;
	operationId: string;
	state: string;
	rowCount: number;
	rejectedTotal: number;
	access: string;
	report: string | null;
	createdBy: string;
	createdAt: number;
	updatedAt: number;
}

export interface AssessmentDbRow {
	id: string;
	operation_id: string;
	state: string;
	row_count: number;
	rejected_total: number;
	access: string;
	report: string | null;
	created_by: string;
	created_at: number;
	updated_at: number;
}

export const toAssessmentRecord = (row: AssessmentDbRow): AssessmentRecord => ({
	id: row.id,
	operationId: row.operation_id,
	state: row.state,
	rowCount: row.row_count,
	rejectedTotal: row.rejected_total,
	access: row.access,
	report: row.report,
	createdBy: row.created_by,
	createdAt: row.created_at,
	updatedAt: row.updated_at
});

export interface EstateRowDb {
	number: number;
	hostname: string;
	state: string;
	class: string | null;
	attempts: number;
	site: string;
	verdict: string | null;
	needs_proof: string | null;
}

export interface EstateRowRecord {
	number: number;
	hostname: string;
	state: string;
	class: string | null;
	attempts: number;
	site: string;
	verdict: string | null;
	needsProof: string | null;
}

export const toRowRecord = (row: EstateRowDb): EstateRowRecord => ({
	number: row.number,
	hostname: row.hostname,
	state: row.state,
	class: row.class,
	attempts: row.attempts,
	site: row.site,
	verdict: row.verdict,
	needsProof: row.needs_proof
});

// a like pattern that matches the text anywhere, with the wildcard characters taken literally
export const likeOf = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
