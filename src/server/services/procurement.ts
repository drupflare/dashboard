import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import {
	PROCUREMENT_KIND_LABELS,
	type ProcurementBody,
	type ProcurementView
} from '../../shared/procurement';
import {
	getProcurement,
	insertProcurement,
	listProcurement,
	updateProcurement,
	type ProcurementRow
} from '../db/repos/procurement';
import { csvLines } from '../domain/csv';

// #region collaborators

export interface ProcurementServices {
	getDb: () => Promise<CollegeDBClient>;
	newId: () => string;
	now: () => number;
}

let installed: ProcurementServices | null = null;

export function setProcurementServices(services: ProcurementServices | null): void {
	installed = services;
}

export function procurementServices(): ProcurementServices {
	if (installed === null) {
		throw new ApiError('not_built', 'Procurement records are not available yet');
	}
	return installed;
}

// #endregion

const iso = (ms: number) => new Date(ms).toISOString();

function viewOf(row: ProcurementRow): ProcurementView {
	return {
		id: row.id,
		kind: row.kind,
		reference: row.reference,
		signatory: row.signatory,
		amount: row.amount,
		issuedOn: row.issuedOn,
		dueOn: row.dueOn,
		notes: row.notes,
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt)
	};
}

function fieldsOf(body: ProcurementBody) {
	return {
		kind: body.kind,
		reference: body.reference,
		signatory: body.signatory ?? null,
		amount: body.amount ?? null,
		issuedOn: body.issuedOn ?? null,
		dueOn: body.dueOn ?? null,
		notes: body.notes ?? null
	};
}

export async function listProcurementViews(
	deps: ProcurementServices,
	orgId: string
): Promise<ProcurementView[]> {
	return (await listProcurement(await deps.getDb(), orgId)).map(viewOf);
}

export async function createProcurement(
	deps: ProcurementServices,
	orgId: string,
	body: ProcurementBody
): Promise<ProcurementView> {
	const now = deps.now();
	const row: ProcurementRow = {
		id: `pr_${deps.newId()}`,
		organizationId: orgId,
		createdAt: now,
		updatedAt: now,
		...fieldsOf(body)
	};
	await insertProcurement(await deps.getDb(), row);
	return viewOf(row);
}

export async function updateProcurementRecord(
	deps: ProcurementServices,
	orgId: string,
	id: string,
	body: ProcurementBody
): Promise<ProcurementView> {
	const db = await deps.getDb();
	const existing = await getProcurement(db, orgId, id);
	if (existing === null) throw new ApiError('not_found', 'Not found');
	const row: ProcurementRow = { ...existing, ...fieldsOf(body), updatedAt: deps.now() };
	await updateProcurement(db, row);
	return viewOf(row);
}

const HEADER = [
	'Kind',
	'Reference',
	'Signatory',
	'Amount',
	'Issued On',
	'Due On',
	'Notes',
	'Recorded At'
];

// the amount goes out as the text the buyer typed; csvLines guards formula-looking cells
export async function procurementCsv(deps: ProcurementServices, orgId: string): Promise<string> {
	const rows = await listProcurement(await deps.getDb(), orgId);
	return csvLines([
		HEADER,
		...rows.map((row) => [
			PROCUREMENT_KIND_LABELS[row.kind],
			row.reference,
			row.signatory,
			row.amount,
			row.issuedOn,
			row.dueOn,
			row.notes,
			iso(row.createdAt)
		])
	]);
}
