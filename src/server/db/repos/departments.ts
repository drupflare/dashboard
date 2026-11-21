import type { CollegeDBClient } from '@earth-app/collegedb';
import type { DepartmentKind, DepartmentRole } from '../../../shared/departments';
import type { Grant } from '../../domain/policy';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';

export interface DepartmentRow {
	id: string;
	organizationId: string;
	parentId: string | null;
	name: string;
	kind: DepartmentKind;
	siteQuota: number | null;
	createdAt: number;
}

export interface DepartmentMemberRow {
	organizationId: string;
	departmentId: string;
	userId: string;
	role: DepartmentRole;
	grantedBy: string;
	grantedAt: number;
}

export interface PlacementRow {
	id: string;
	name: string;
	departmentId: string | null;
}

interface DepartmentDb {
	id: string;
	organization_id: string;
	parent_id: string | null;
	name: string;
	kind: DepartmentKind;
	site_quota: number | null;
	created_at: number;
}

interface MemberDb {
	organization_id: string;
	department_id: string;
	user_id: string;
	role: DepartmentRole;
	granted_by: string;
	granted_at: number;
}

const COLUMNS = 'id, organization_id, parent_id, name, kind, site_quota, created_at';
const MEMBER_COLUMNS = 'organization_id, department_id, user_id, role, granted_by, granted_at';
// a site that is gone no longer holds a place or counts toward a quota
const LIVE_SITE = `state IN ('active', 'suspended')`;

const toRow = (row: DepartmentDb): DepartmentRow => ({
	id: row.id,
	organizationId: row.organization_id,
	parentId: row.parent_id,
	name: row.name,
	kind: row.kind,
	siteQuota: row.site_quota,
	createdAt: row.created_at
});

const toMember = (row: MemberDb): DepartmentMemberRow => ({
	organizationId: row.organization_id,
	departmentId: row.department_id,
	userId: row.user_id,
	role: row.role,
	grantedBy: row.granted_by,
	grantedAt: row.granted_at
});

// #region departments

export async function listDepartments(
	db: CollegeDBClient,
	organizationId: string
): Promise<DepartmentRow[]> {
	const { results } = await db.all<DepartmentDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM departments WHERE organization_id = ? ORDER BY name, id`,
		[organizationId]
	);
	return results.map(toRow);
}

export async function getDepartment(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<DepartmentRow | null> {
	const row = await db.first<DepartmentDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM departments WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toRow(row) : null;
}

// a sibling with the same name, ignoring case, raises DuplicateRowError
export async function insertDepartment(db: CollegeDBClient, row: DepartmentRow): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			row.organizationId,
			`INSERT INTO departments (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				row.id,
				row.organizationId,
				row.parentId,
				row.name,
				row.kind,
				row.siteQuota,
				row.createdAt
			]
		)
	);
}

export async function updateDepartment(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	fields: { name: string; parentId: string | null }
): Promise<boolean> {
	return uniqueOrDuplicate(async () =>
		wasChanged(
			await db.run(
				organizationId,
				`UPDATE departments SET name = ?, parent_id = ? WHERE organization_id = ? AND id = ?`,
				[fields.name, fields.parentId, organizationId, id]
			)
		)
	);
}

export async function setDepartmentQuota(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	siteQuota: number | null
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`UPDATE departments SET site_quota = ? WHERE organization_id = ? AND id = ?`,
			[siteQuota, organizationId, id]
		)
	);
}

// the department's members go with it; the service refuses before this while sites or children remain
export async function deleteDepartment(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<boolean> {
	await db.run(
		organizationId,
		`DELETE FROM department_members WHERE organization_id = ? AND department_id = ?`,
		[organizationId, id]
	);
	return wasChanged(
		await db.run(
			organizationId,
			`DELETE FROM departments WHERE organization_id = ? AND id = ?`,
			[organizationId, id]
		)
	);
}

// live sites placed directly in each department
export async function siteCounts(
	db: CollegeDBClient,
	organizationId: string
): Promise<Map<string, number>> {
	const { results } = await db.all<{ department_id: string; n: number }>(
		organizationId,
		`SELECT department_id, COUNT(*) AS n FROM sites
		 WHERE organization_id = ? AND department_id IS NOT NULL AND ${LIVE_SITE}
		 GROUP BY department_id`,
		[organizationId]
	);
	return new Map(results.map((row) => [row.department_id, row.n]));
}

export async function memberCounts(
	db: CollegeDBClient,
	organizationId: string
): Promise<Map<string, number>> {
	const { results } = await db.all<{ department_id: string; n: number }>(
		organizationId,
		`SELECT department_id, COUNT(*) AS n FROM department_members
		 WHERE organization_id = ? GROUP BY department_id`,
		[organizationId]
	);
	return new Map(results.map((row) => [row.department_id, row.n]));
}

// #endregion

// #region members

export async function listDepartmentMembers(
	db: CollegeDBClient,
	organizationId: string,
	departmentId: string
): Promise<DepartmentMemberRow[]> {
	const { results } = await db.all<MemberDb>(
		organizationId,
		`SELECT ${MEMBER_COLUMNS} FROM department_members
		 WHERE organization_id = ? AND department_id = ? ORDER BY granted_at, user_id`,
		[organizationId, departmentId]
	);
	return results.map(toMember);
}

export async function getDepartmentMember(
	db: CollegeDBClient,
	organizationId: string,
	departmentId: string,
	userId: string
): Promise<DepartmentMemberRow | null> {
	const row = await db.first<MemberDb>(
		organizationId,
		`SELECT ${MEMBER_COLUMNS} FROM department_members
		 WHERE organization_id = ? AND department_id = ? AND user_id = ?`,
		[organizationId, departmentId, userId]
	);
	return row ? toMember(row) : null;
}

// a person holds one role in a department; a second add raises DuplicateRowError
export async function insertDepartmentMember(
	db: CollegeDBClient,
	row: DepartmentMemberRow
): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			row.organizationId,
			`INSERT INTO department_members (${MEMBER_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`,
			[
				row.organizationId,
				row.departmentId,
				row.userId,
				row.role,
				row.grantedBy,
				row.grantedAt
			]
		)
	);
}

export async function setDepartmentMemberRole(
	db: CollegeDBClient,
	organizationId: string,
	departmentId: string,
	userId: string,
	role: DepartmentRole
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`UPDATE department_members SET role = ?
			 WHERE organization_id = ? AND department_id = ? AND user_id = ?`,
			[role, organizationId, departmentId, userId]
		)
	);
}

export async function removeDepartmentMember(
	db: CollegeDBClient,
	organizationId: string,
	departmentId: string,
	userId: string
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`DELETE FROM department_members
			 WHERE organization_id = ? AND department_id = ? AND user_id = ?`,
			[organizationId, departmentId, userId]
		)
	);
}

// a person who leaves the organisation leaves every department with it
export async function removeUserDepartmentMembers(
	db: CollegeDBClient,
	organizationId: string,
	userId: string
): Promise<void> {
	await db.run(
		organizationId,
		`DELETE FROM department_members WHERE organization_id = ? AND user_id = ?`,
		[organizationId, userId]
	);
}

// the department roles one user holds, in the shape the authorize walk reads
export async function listUserDepartmentGrants(
	db: CollegeDBClient,
	organizationId: string,
	userId: string
): Promise<Grant[]> {
	const { results } = await db.all<{ department_id: string; role: DepartmentRole }>(
		organizationId,
		`SELECT department_id, role FROM department_members
		 WHERE organization_id = ? AND user_id = ?`,
		[organizationId, userId]
	);
	return results.map((row) => ({
		level: 'department',
		orgId: organizationId,
		targetId: row.department_id,
		role: row.role
	}));
}

// #endregion

// #region sites

export async function getSiteDepartment(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<{ departmentId: string | null } | null> {
	const row = await db.first<{ department_id: string | null }>(
		organizationId,
		`SELECT department_id FROM sites WHERE organization_id = ? AND id = ?`,
		[organizationId, siteId]
	);
	return row ? { departmentId: row.department_id } : null;
}

export async function setSiteDepartment(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	departmentId: string | null
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`UPDATE sites SET department_id = ? WHERE organization_id = ? AND id = ?`,
			[departmentId, organizationId, siteId]
		)
	);
}

export async function listPlacements(
	db: CollegeDBClient,
	organizationId: string
): Promise<PlacementRow[]> {
	const { results } = await db.all<{ id: string; name: string; department_id: string | null }>(
		organizationId,
		`SELECT id, name, department_id FROM sites
		 WHERE organization_id = ? AND ${LIVE_SITE} ORDER BY name, id`,
		[organizationId]
	);
	return results.map((row) => ({ id: row.id, name: row.name, departmentId: row.department_id }));
}

// #endregion
