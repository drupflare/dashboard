import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ProcurementKind } from '../../../shared/procurement';
import { wasChanged } from '../collegedb';

export interface ProcurementRow {
	id: string;
	organizationId: string;
	kind: ProcurementKind;
	reference: string;
	signatory: string | null;
	amount: string | null;
	issuedOn: string | null;
	dueOn: string | null;
	notes: string | null;
	createdAt: number;
	updatedAt: number;
}

interface ProcurementDb {
	id: string;
	organization_id: string;
	kind: ProcurementKind;
	reference: string;
	signatory: string | null;
	amount: string | null;
	issued_on: string | null;
	due_on: string | null;
	notes: string | null;
	created_at: number;
	updated_at: number;
}

const COLUMNS =
	'id, organization_id, kind, reference, signatory, amount, issued_on, due_on, notes, created_at, updated_at';

function toRow(row: ProcurementDb): ProcurementRow {
	return {
		id: row.id,
		organizationId: row.organization_id,
		kind: row.kind,
		reference: row.reference,
		signatory: row.signatory,
		amount: row.amount,
		issuedOn: row.issued_on,
		dueOn: row.due_on,
		notes: row.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export async function listProcurement(
	db: CollegeDBClient,
	organizationId: string
): Promise<ProcurementRow[]> {
	const { results } = await db.all<ProcurementDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM procurement_records WHERE organization_id = ?
		 ORDER BY created_at, id`,
		[organizationId]
	);
	return results.map(toRow);
}

export async function getProcurement(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<ProcurementRow | null> {
	const row = await db.first<ProcurementDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM procurement_records WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toRow(row) : null;
}

export async function insertProcurement(db: CollegeDBClient, row: ProcurementRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO procurement_records (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		[
			row.id,
			row.organizationId,
			row.kind,
			row.reference,
			row.signatory,
			row.amount,
			row.issuedOn,
			row.dueOn,
			row.notes,
			row.createdAt,
			row.updatedAt
		]
	);
}

export async function updateProcurement(
	db: CollegeDBClient,
	row: ProcurementRow
): Promise<boolean> {
	return wasChanged(
		await db.run(
			row.organizationId,
			`UPDATE procurement_records SET kind = ?, reference = ?, signatory = ?, amount = ?,
			 issued_on = ?, due_on = ?, notes = ?, updated_at = ?
			 WHERE organization_id = ? AND id = ?`,
			[
				row.kind,
				row.reference,
				row.signatory,
				row.amount,
				row.issuedOn,
				row.dueOn,
				row.notes,
				row.updatedAt,
				row.organizationId,
				row.id
			]
		)
	);
}
