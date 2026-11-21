import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../../shared/errors';
import {
	policyRulesSchema,
	type AssignmentKind,
	type Classification,
	type PolicyRules
} from '../../../shared/policies';
import { chainOf } from '../../domain/departments';
import {
	operationRefusal,
	stackFor,
	toPolicyGroup,
	type CheckOutcome,
	type PolicyGroup,
	type StoredAssignment
} from '../../domain/policy';
import { uniqueOrDuplicate, wasChanged } from '../collegedb';
import { listDepartments } from './departments';

export interface PolicyGroupRow {
	id: string;
	organizationId: string;
	name: string;
	rules: PolicyRules;
	createdAt: number;
}

interface GroupDb {
	id: string;
	organization_id: string;
	name: string;
	rules: string;
	created_at: number;
}

const COLUMNS = 'id, organization_id, name, rules, created_at';

const toRow = (row: GroupDb): PolicyGroupRow => ({
	id: row.id,
	organizationId: row.organization_id,
	name: row.name,
	rules: policyRulesSchema.parse(JSON.parse(row.rules)),
	createdAt: row.created_at
});

// #region groups

export async function listPolicyGroups(
	db: CollegeDBClient,
	organizationId: string
): Promise<PolicyGroupRow[]> {
	const { results } = await db.all<GroupDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM policy_groups WHERE organization_id = ? ORDER BY name, id`,
		[organizationId]
	);
	return results.map(toRow);
}

export async function getPolicyGroup(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<PolicyGroupRow | null> {
	const row = await db.first<GroupDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM policy_groups WHERE organization_id = ? AND id = ?`,
		[organizationId, id]
	);
	return row ? toRow(row) : null;
}

// a group with the same name, ignoring case, raises DuplicateRowError
export async function insertPolicyGroup(db: CollegeDBClient, row: PolicyGroupRow): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			row.organizationId,
			`INSERT INTO policy_groups (${COLUMNS}) VALUES (?, ?, ?, ?, ?)`,
			[row.id, row.organizationId, row.name, JSON.stringify(row.rules), row.createdAt]
		)
	);
}

export async function updatePolicyGroup(
	db: CollegeDBClient,
	organizationId: string,
	id: string,
	fields: { name: string; rules: PolicyRules }
): Promise<boolean> {
	return uniqueOrDuplicate(async () =>
		wasChanged(
			await db.run(
				organizationId,
				`UPDATE policy_groups SET name = ?, rules = ? WHERE organization_id = ? AND id = ?`,
				[fields.name, JSON.stringify(fields.rules), organizationId, id]
			)
		)
	);
}

export async function deletePolicyGroup(
	db: CollegeDBClient,
	organizationId: string,
	id: string
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`DELETE FROM policy_groups WHERE organization_id = ? AND id = ?`,
			[organizationId, id]
		)
	);
}

// #endregion

// #region assignments

export async function listAssignments(
	db: CollegeDBClient,
	organizationId: string
): Promise<StoredAssignment[]> {
	const { results } = await db.all<{
		group_id: string;
		target_kind: AssignmentKind;
		target_id: string;
	}>(
		organizationId,
		`SELECT group_id, target_kind, target_id FROM policy_assignments
		 WHERE organization_id = ? ORDER BY group_id, target_kind, target_id`,
		[organizationId]
	);
	return results.map((r) => ({
		groupId: r.group_id,
		kind: r.target_kind,
		targetId: r.target_id
	}));
}

// a label has one default group, so a new pick replaces the old one
export async function addAssignment(
	db: CollegeDBClient,
	row: {
		organizationId: string;
		groupId: string;
		kind: AssignmentKind;
		targetId: string;
		by: string;
		at: number;
	}
): Promise<'added' | 'present'> {
	if (row.kind === 'classification') {
		await db.run(
			row.organizationId,
			`DELETE FROM policy_assignments
			 WHERE organization_id = ? AND target_kind = 'classification' AND target_id = ? AND group_id <> ?`,
			[row.organizationId, row.targetId, row.groupId]
		);
	}
	const result = await db.run(
		row.organizationId,
		`INSERT OR IGNORE INTO policy_assignments
		 (organization_id, group_id, target_kind, target_id, assigned_by, assigned_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		[row.organizationId, row.groupId, row.kind, row.targetId, row.by, row.at]
	);
	return wasChanged(result) ? 'added' : 'present';
}

export async function removeAssignment(
	db: CollegeDBClient,
	organizationId: string,
	groupId: string,
	kind: AssignmentKind,
	targetId: string
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`DELETE FROM policy_assignments
			 WHERE organization_id = ? AND group_id = ? AND target_kind = ? AND target_id = ?`,
			[organizationId, groupId, kind, targetId]
		)
	);
}

export async function countAssignments(
	db: CollegeDBClient,
	organizationId: string,
	groupId: string
): Promise<number> {
	const row = await db.first<{ n: number }>(
		organizationId,
		`SELECT COUNT(*) AS n FROM policy_assignments WHERE organization_id = ? AND group_id = ?`,
		[organizationId, groupId]
	);
	return row?.n ?? 0;
}

// #endregion

// #region classification

export async function listClassificationNames(
	db: CollegeDBClient,
	organizationId: string
): Promise<Map<Classification, string>> {
	const { results } = await db.all<{ label: Classification; display_name: string }>(
		organizationId,
		`SELECT label, display_name FROM org_classification_map WHERE organization_id = ?`,
		[organizationId]
	);
	return new Map(results.map((r) => [r.label, r.display_name]));
}

export async function setClassificationName(
	db: CollegeDBClient,
	organizationId: string,
	label: Classification,
	displayName: string | null
): Promise<void> {
	if (displayName === null) {
		await db.run(
			organizationId,
			`DELETE FROM org_classification_map WHERE organization_id = ? AND label = ?`,
			[organizationId, label]
		);
		return;
	}
	await db.run(
		organizationId,
		`INSERT INTO org_classification_map (organization_id, label, display_name) VALUES (?, ?, ?)
		 ON CONFLICT (organization_id, label) DO UPDATE SET display_name = excluded.display_name`,
		[organizationId, label, displayName]
	);
}

export async function getSiteClassification(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string
): Promise<{ classification: Classification | null; departmentId: string | null } | null> {
	const row = await db.first<{
		classification: Classification | null;
		department_id: string | null;
	}>(
		organizationId,
		`SELECT classification, department_id FROM sites WHERE organization_id = ? AND id = ?`,
		[organizationId, siteId]
	);
	return row ? { classification: row.classification, departmentId: row.department_id } : null;
}

export async function setSiteClassification(
	db: CollegeDBClient,
	organizationId: string,
	siteId: string,
	classification: Classification | null
): Promise<boolean> {
	return wasChanged(
		await db.run(
			organizationId,
			`UPDATE sites SET classification = ? WHERE organization_id = ? AND id = ?`,
			[classification, organizationId, siteId]
		)
	);
}

// #endregion

// #region the stack for one place

// the groups that apply to an organisation, a department or a site; an organisation with no group
// costs one read
export async function loadPolicyFor(
	db: CollegeDBClient,
	input: { orgId: string; siteId?: string; departmentId?: string }
): Promise<PolicyGroup[]> {
	const rows = await listPolicyGroups(db, input.orgId);
	if (rows.length === 0) return [];
	const assignments = await listAssignments(db, input.orgId);
	if (assignments.length === 0) return [];
	let departmentId = input.departmentId;
	let classification: Classification | null = null;
	if (input.siteId !== undefined) {
		const site = await getSiteClassification(db, input.orgId, input.siteId);
		classification = site?.classification ?? null;
		departmentId = site?.departmentId ?? departmentId;
	}
	const tree =
		departmentId === undefined
			? []
			: (await listDepartments(db, input.orgId)).map((r) => ({
					id: r.id,
					parentId: r.parentId,
					kind: r.kind
				}));
	const groups = new Map(rows.map((row) => [row.id, toPolicyGroup(row)]));
	return stackFor({
		groups,
		assignments: assignments.filter((a) => groups.has(a.groupId)),
		orgId: input.orgId,
		...(departmentId === undefined ? {} : { chain: chainOf(tree, departmentId) }),
		...(input.siteId === undefined ? {} : { siteId: input.siteId }),
		classification
	});
}

// the groups a site would meet in an organisation it has not joined yet: the organisation's own
// and the default group of the site's classification
export async function loadPolicyForIncoming(
	db: CollegeDBClient,
	input: { orgId: string; classification: Classification | null }
): Promise<PolicyGroup[]> {
	const rows = await listPolicyGroups(db, input.orgId);
	if (rows.length === 0) return [];
	const assignments = await listAssignments(db, input.orgId);
	if (assignments.length === 0) return [];
	const groups = new Map(rows.map((row) => [row.id, toPolicyGroup(row)]));
	return stackFor({
		groups,
		assignments: assignments.filter((a) => groups.has(a.groupId)),
		orgId: input.orgId,
		classification: input.classification
	});
}

export function refuseBlock(outcome: CheckOutcome | null): void {
	if (outcome?.status !== 'blocked') return;
	throw new ApiError('forbidden', outcome.message, {
		requires: 'policy',
		policy: outcome.policy,
		policyName: outcome.policyName,
		rule: outcome.rule
	});
}

// run by every operation start before anything is recorded; a block fails the start with the
// policy group and rule named
export async function assertOperationAllowed(
	db: CollegeDBClient,
	operation: {
		organizationId: string;
		siteId: string | null;
		type: string;
		inputs?: unknown;
		now: number;
	}
): Promise<void> {
	const groups = await loadPolicyFor(db, {
		orgId: operation.organizationId,
		...(operation.siteId === null ? {} : { siteId: operation.siteId })
	});
	refuseBlock(
		operationRefusal(groups, {
			type: operation.type,
			inputs: operation.inputs,
			now: operation.now
		})
	);
}

// the same read for a service that checks one named rule before it writes
export async function assertPolicy(
	db: CollegeDBClient,
	place: { orgId: string; siteId?: string; departmentId?: string },
	check: (groups: readonly PolicyGroup[]) => CheckOutcome | null
): Promise<void> {
	refuseBlock(check(await loadPolicyFor(db, place)));
}

// #endregion
