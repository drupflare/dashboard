import type { CollegeDBClient } from '@earth-app/collegedb';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';

export interface CostCenterRow {
	id: string;
	organizationId: string;
	code: string;
	name: string;
	departmentId: string | null;
	ownerContact: string | null;
	createdAt: number;
}

export interface OrgSiteRow {
	id: string;
	name: string;
	costCenterId: string | null;
	technicalOwner: string | null;
	businessOwner: string | null;
}

interface CostCenterDb {
	id: string;
	organization_id: string;
	code: string;
	name: string;
	department_id: string | null;
	owner_contact: string | null;
	created_at: number;
}

const COLUMNS = 'id, organization_id, code, name, department_id, owner_contact, created_at';

function toRow(row: CostCenterDb): CostCenterRow {
	return {
		id: row.id,
		organizationId: row.organization_id,
		code: row.code,
		name: row.name,
		departmentId: row.department_id,
		ownerContact: row.owner_contact,
		createdAt: row.created_at
	};
}

export async function listCostCenters(
	db: CollegeDBClient,
	organizationId: string
): Promise<CostCenterRow[]> {
	const { results } = await db.all<CostCenterDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM cost_centers WHERE organization_id = ? ORDER BY code, id`,
		[organizationId]
	);
	return results.map(toRow);
}

export async function getCostCenter(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<CostCenterRow | null> {
	const row = await db.first<CostCenterDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM cost_centers WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toRow(row) : null;
}

// a code is unique within the organisation; a clash raises DuplicateRowError
export async function insertCostCenter(db: CollegeDBClient, row: CostCenterRow): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			row.organizationId,
			`INSERT INTO cost_centers (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.organizationId,
				row.code,
				row.name,
				row.departmentId,
				row.ownerContact,
				row.createdAt
			]
		)
	);
}

export async function updateCostCenter(db: CollegeDBClient, row: CostCenterRow): Promise<boolean> {
	return uniqueOrDuplicate(async () =>
		wasChanged(
			await db.run(
				row.organizationId,
				`UPDATE cost_centers SET code = ?, name = ?, department_id = ?, owner_contact = ?
				 WHERE organization_id = ? AND id = ?`,
				[row.code, row.name, row.departmentId, row.ownerContact, row.organizationId, row.id]
			)
		)
	);
}

// the sites an organisation can still see; a tombstoned site leaves the report
export async function listOrgSites(
	db: CollegeDBClient,
	organizationId: string
): Promise<OrgSiteRow[]> {
	const { results } = await db.all<{
		id: string;
		name: string;
		cost_center_id: string | null;
		technical_owner: string | null;
		business_owner: string | null;
	}>(
		organizationId,
		`SELECT id, name, cost_center_id, technical_owner, business_owner FROM sites
		 WHERE organization_id = ? AND state IN ('active', 'suspended')
		 ORDER BY id`,
		[organizationId]
	);
	return results.map((row) => ({
		id: row.id,
		name: row.name,
		costCenterId: row.cost_center_id,
		technicalOwner: row.technical_owner,
		businessOwner: row.business_owner
	}));
}

export async function setSiteAssignment(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	site: Omit<OrgSiteRow, 'id' | 'name'>
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`UPDATE sites SET cost_center_id = ?, technical_owner = ?, business_owner = ?
			 WHERE organization_id = ? AND id = ?`,
			[site.costCenterId, site.technicalOwner, site.businessOwner, organizationId, siteId]
		)
	);
}
