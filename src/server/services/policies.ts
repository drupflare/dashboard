import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import {
	CLASSIFICATIONS,
	type Classification,
	type PolicyAssignment,
	type PolicyGroupBody,
	type PolicyGroupView,
	type PolicyList,
	type SiteClassificationView
} from '../../shared/policies';
import { DuplicateRowError } from '../db/collegedb';
import { getDepartment } from '../db/repos/departments';
import {
	addAssignment,
	countAssignments,
	deletePolicyGroup,
	getPolicyGroup,
	getSiteClassification,
	insertPolicyGroup,
	listAssignments,
	listClassificationNames,
	listPolicyGroups,
	removeAssignment,
	setClassificationName,
	setSiteClassification,
	updatePolicyGroup,
	type PolicyGroupRow
} from '../db/repos/policies';
import type { StoredAssignment } from '../domain/policy';
import type { AuditInput } from './audit';
import type { Actor } from './departments';
import { principalActor } from './owner-tokens';

// #region collaborators

export interface PolicyServices {
	getDb: () => Promise<CollegeDBClient>;
	audit: (orgId: string, input: AuditInput) => Promise<unknown>;
	newId: () => string;
	now: () => number;
}

let installed: PolicyServices | null = null;

export function setPolicyServices(services: PolicyServices | null): void {
	installed = services;
}

export function policyServices(): PolicyServices {
	if (installed === null) throw new ApiError('not_built', 'Policy groups are not available yet');
	return installed;
}

export const defaultPolicyServices = (
	getDb: () => Promise<CollegeDBClient>,
	audit: PolicyServices['audit']
): PolicyServices => ({
	getDb,
	audit,
	newId: () => crypto.randomUUID().replaceAll('-', ''),
	now: Date.now
});

// #endregion

const iso = (ms: number) => new Date(ms).toISOString();

const viewOf = (
	row: PolicyGroupRow,
	assignments: readonly StoredAssignment[]
): PolicyGroupView => ({
	id: row.id,
	name: row.name,
	rules: row.rules,
	assignments: assignments
		.filter((a) => a.groupId === row.id)
		.map((a) => ({ kind: a.kind, targetId: a.targetId })),
	createdAt: iso(row.createdAt)
});

const record = (
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	action: string,
	target: string,
	detail: Record<string, unknown> = {}
) => deps.audit(orgId, { actor: principalActor(actor.principal), action, target, detail });

const duplicateName = () =>
	new ApiError('conflict', 'A policy group with that name already exists', {
		reason: 'duplicate_name'
	});

const missing = () => new ApiError('not_found', 'Not found');

async function groupOrThrow(db: CollegeDBClient, orgId: string, id: string) {
	const row = await getPolicyGroup(db, orgId, id);
	if (row === null) throw missing();
	return row;
}

// #region groups

export async function listPolicies(deps: PolicyServices, orgId: string): Promise<PolicyList> {
	const db = await deps.getDb();
	const [rows, assignments, names] = await Promise.all([
		listPolicyGroups(db, orgId),
		listAssignments(db, orgId),
		listClassificationNames(db, orgId)
	]);
	return {
		items: rows.map((row) => viewOf(row, assignments)),
		classifications: CLASSIFICATIONS.map((label) => ({
			label,
			displayName: names.get(label) ?? null,
			policyId:
				assignments.find((a) => a.kind === 'classification' && a.targetId === label)
					?.groupId ?? null
		}))
	};
}

export async function createPolicy(
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	body: PolicyGroupBody
): Promise<PolicyGroupView> {
	const db = await deps.getDb();
	const row: PolicyGroupRow = {
		id: `pol_${deps.newId()}`,
		organizationId: orgId,
		name: body.name,
		rules: body.rules,
		createdAt: deps.now()
	};
	try {
		await insertPolicyGroup(db, row);
	} catch (error) {
		if (error instanceof DuplicateRowError) throw duplicateName();
		throw error;
	}
	await record(deps, orgId, actor, 'policy.created', row.id, { name: row.name });
	return viewOf(row, []);
}

export async function updatePolicy(
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	id: string,
	body: PolicyGroupBody
): Promise<PolicyGroupView> {
	const db = await deps.getDb();
	const current = await groupOrThrow(db, orgId, id);
	try {
		await updatePolicyGroup(db, orgId, id, { name: body.name, rules: body.rules });
	} catch (error) {
		if (error instanceof DuplicateRowError) throw duplicateName();
		throw error;
	}
	await record(deps, orgId, actor, 'policy.updated', id, {
		name: body.name,
		...(body.name === current.name ? {} : { was: current.name })
	});
	return viewOf(
		{ ...current, name: body.name, rules: body.rules },
		await listAssignments(db, orgId)
	);
}

// a group in use is unassigned first, so nothing loses its guardrail without somebody choosing it
export async function deletePolicy(
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	id: string
): Promise<void> {
	const db = await deps.getDb();
	const current = await groupOrThrow(db, orgId, id);
	if ((await countAssignments(db, orgId, id)) > 0) {
		throw new ApiError('conflict', 'Remove this group from everything it applies to first', {
			reason: 'assigned'
		});
	}
	await deletePolicyGroup(db, orgId, id);
	await record(deps, orgId, actor, 'policy.deleted', id, { name: current.name });
}

// #endregion

// #region assignments

async function checkTarget(
	db: CollegeDBClient,
	orgId: string,
	target: PolicyAssignment
): Promise<void> {
	const { kind, targetId } = target;
	const ok =
		kind === 'organization'
			? targetId === orgId
			: kind === 'department'
				? (await getDepartment(db, orgId, targetId)) !== null
				: kind === 'site'
					? (await getSiteClassification(db, orgId, targetId)) !== null
					: (CLASSIFICATIONS as readonly string[]).includes(targetId);
	if (!ok) {
		throw new ApiError('validation', 'Choose a target from this organization', {
			field: 'targetId'
		});
	}
}

export async function assignPolicy(
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	id: string,
	target: PolicyAssignment
): Promise<PolicyGroupView> {
	const db = await deps.getDb();
	const group = await groupOrThrow(db, orgId, id);
	await checkTarget(db, orgId, target);
	const by = actor.principal.kind === 'user' ? actor.principal.userId : actor.principal.issuerId;
	const result = await addAssignment(db, {
		organizationId: orgId,
		groupId: id,
		kind: target.kind,
		targetId: target.targetId,
		by,
		at: deps.now()
	});
	if (result === 'added') {
		await record(deps, orgId, actor, 'policy.assigned', id, { ...target });
	}
	return viewOf(group, await listAssignments(db, orgId));
}

export async function unassignPolicy(
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	id: string,
	target: PolicyAssignment
): Promise<void> {
	const db = await deps.getDb();
	await groupOrThrow(db, orgId, id);
	if (!(await removeAssignment(db, orgId, id, target.kind, target.targetId))) throw missing();
	await record(deps, orgId, actor, 'policy.unassigned', id, { ...target });
}

// #endregion

// #region classification

export async function setClassificationDisplayName(
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	label: Classification,
	displayName: string | null
): Promise<PolicyList> {
	const db = await deps.getDb();
	await setClassificationName(db, orgId, label, displayName);
	await record(deps, orgId, actor, 'policy.classification.named', label, { displayName });
	return listPolicies(deps, orgId);
}

export async function classifySite(
	deps: PolicyServices,
	orgId: string,
	actor: Actor,
	siteId: string,
	classification: Classification | null
): Promise<SiteClassificationView> {
	const db = await deps.getDb();
	const site = await getSiteClassification(db, orgId, siteId);
	if (site === null) throw missing();
	if (site.classification !== classification) {
		await setSiteClassification(db, orgId, siteId, classification);
		await record(deps, orgId, actor, 'site.classification.set', siteId, {
			from: site.classification,
			to: classification
		});
	}
	return { siteId, classification };
}

export async function siteClassification(
	deps: PolicyServices,
	orgId: string,
	siteId: string
): Promise<SiteClassificationView> {
	const site = await getSiteClassification(await deps.getDb(), orgId, siteId);
	if (site === null) throw missing();
	return { siteId, classification: site.classification };
}

// #endregion
