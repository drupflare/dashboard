import type { CollegeDBClient } from '@earth-app/collegedb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CHANGE_BUDGET } from '../../../contracts/src/operations';
import { DuplicateRowError, ensureCollegeDB } from '../../../src/server/db/collegedb';
import { createOperationRecord } from '../../../src/server/db/repos/backups';
import { insertDepartment, type DepartmentRow } from '../../../src/server/db/repos/departments';
import { createUser } from '../../../src/server/db/repos/identity';
import { addMember, createOrganization } from '../../../src/server/db/repos/organization';
import {
	addAssignment,
	assertPolicy,
	countAssignments,
	getPolicyGroup,
	insertPolicyGroup,
	listAssignments,
	listPolicyGroups,
	loadPolicyFor,
	removeAssignment,
	updatePolicyGroup
} from '../../../src/server/db/repos/policies';
import { authorize, type Facts, type Principal } from '../../../src/server/domain/authorize';
import { checkTemplate } from '../../../src/server/domain/policy';
import type { Actor } from '../../../src/server/services/departments';
import { collegeFactsStore, loadFacts } from '../../../src/server/services/facts';
import {
	assignPolicy,
	classifySite,
	createPolicy,
	deletePolicy,
	listPolicies,
	setClassificationDisplayName,
	siteClassification,
	unassignPolicy,
	updatePolicy,
	type PolicyServices
} from '../../../src/server/services/policies';
import { ApiError } from '../../../src/shared/errors';
import type { PolicyRules } from '../../../src/shared/policies';
import { facts as baseFacts } from '../../unit/domain/fixtures';
import { openBindings, TWO_SHARD_CONFIG, type Bindings, type OpenBindings } from '../support';

let harness: OpenBindings;
let env: Bindings;
let db: CollegeDBClient;

beforeAll(async () => {
	harness = await openBindings(TWO_SHARD_CONFIG);
	env = harness.env;
	db = await ensureCollegeDB(env);
});

afterAll(() => harness.close());

const tag = () => crypto.randomUUID().replaceAll('-', '');
const email = (name: string) => `${name}-${tag()}@example.test`;

async function organisation() {
	const founder = await createUser(db, { email: email('founder') });
	const org = await createOrganization(db, {
		name: 'Policies Test',
		personal: false,
		createdBy: founder.id
	});
	await addMember(db, org.id, { userId: founder.id, role: 'owner' });
	return { orgId: org.id, founder };
}

function dept(orgId: string, name: string, over: Partial<DepartmentRow> = {}): DepartmentRow {
	return {
		id: `dept_${tag()}`,
		organizationId: orgId,
		parentId: null,
		name,
		kind: 'department',
		siteQuota: null,
		createdAt: 1000,
		...over
	};
}

async function site(
	orgId: string,
	over: { departmentId?: string | null; classification?: string | null } = {}
) {
	const id = `site_${tag()}`;
	await db.run(
		orgId,
		`INSERT INTO sites (id, organization_id, name, plane, state, department_id, classification, created_at, updated_at)
		 VALUES (?, ?, ?, 'managed', 'active', ?, ?, 1, 1)`,
		[id, orgId, `n${id.slice(-8)}`, over.departmentId ?? null, over.classification ?? null]
	);
	return id;
}

const audits: { orgId: string; action: string; target: string; detail?: unknown }[] = [];
const services: PolicyServices = {
	getDb: async () => db,
	audit: async (orgId, input) => {
		audits.push({ orgId, ...input });
	},
	newId: tag,
	now: () => 5000
};

const asUser = (userId: string): Principal => ({ kind: 'user', userId });
const actorFor = (userId: string): Actor => ({
	principal: asUser(userId),
	facts: baseFacts({})
});

const row = (orgId: string, name: string, rules: PolicyRules = {}) => ({
	id: `pol_${tag()}`,
	organizationId: orgId,
	name,
	rules,
	createdAt: 1000
});

describe('policy group rows', () => {
	it('stores, reads, updates and deletes a group with its rules', async () => {
		const { orgId } = await organisation();
		const g = row(orgId, 'Freeze', { blockedActions: ['site.deploy'], maxPreviewHours: 24 });
		await insertPolicyGroup(db, g);
		expect(await getPolicyGroup(db, orgId, g.id)).toEqual(g);
		expect(await updatePolicyGroup(db, orgId, g.id, { name: 'Freeze 2', rules: {} })).toBe(
			true
		);
		expect((await listPolicyGroups(db, orgId)).map((r) => r.name)).toEqual(['Freeze 2']);
		expect(await updatePolicyGroup(db, orgId, 'nope', { name: 'x', rules: {} })).toBe(false);
	});

	it('refuses a second group with the same name, ignoring case', async () => {
		const { orgId } = await organisation();
		await insertPolicyGroup(db, row(orgId, 'Same'));
		await expect(insertPolicyGroup(db, row(orgId, 'SAME'))).rejects.toBeInstanceOf(
			DuplicateRowError
		);
		const other = await organisation();
		await insertPolicyGroup(db, row(other.orgId, 'Same'));
	});

	it('never reads another organisation group', async () => {
		const a = await organisation();
		const b = await organisation();
		const g = row(a.orgId, 'Mine');
		await insertPolicyGroup(db, g);
		expect(await getPolicyGroup(db, b.orgId, g.id)).toBeNull();
		expect(await listPolicyGroups(db, b.orgId)).toEqual([]);
	});
});

describe('assignments and the stack for a place', () => {
	it('adds once, replaces a label default and removes', async () => {
		const { orgId } = await organisation();
		const a = row(orgId, 'A');
		const b = row(orgId, 'B');
		await insertPolicyGroup(db, a);
		await insertPolicyGroup(db, b);
		const base = { organizationId: orgId, by: 'u', at: 1 };
		expect(
			await addAssignment(db, {
				...base,
				groupId: a.id,
				kind: 'organization',
				targetId: orgId
			})
		).toBe('added');
		expect(
			await addAssignment(db, {
				...base,
				groupId: a.id,
				kind: 'organization',
				targetId: orgId
			})
		).toBe('present');
		await addAssignment(db, {
			...base,
			groupId: a.id,
			kind: 'classification',
			targetId: 'restricted'
		});
		await addAssignment(db, {
			...base,
			groupId: b.id,
			kind: 'classification',
			targetId: 'restricted'
		});
		const labels = (await listAssignments(db, orgId)).filter(
			(x) => x.kind === 'classification'
		);
		expect(labels).toEqual([{ groupId: b.id, kind: 'classification', targetId: 'restricted' }]);
		expect(await countAssignments(db, orgId, a.id)).toBe(1);
		expect(await removeAssignment(db, orgId, a.id, 'organization', orgId)).toBe(true);
		expect(await removeAssignment(db, orgId, a.id, 'organization', orgId)).toBe(false);
	});

	it('stacks organisation, department chain, site and label for a site', async () => {
		const { orgId } = await organisation();
		const top = dept(orgId, 'Top', { kind: 'division' });
		const low = dept(orgId, 'Low', { parentId: top.id });
		await insertDepartment(db, top);
		await insertDepartment(db, low);
		const s = await site(orgId, { departmentId: low.id, classification: 'restricted' });
		const groups = Object.fromEntries(
			await Promise.all(
				['org', 'top', 'low', 'site', 'label'].map(async (n) => {
					const g = row(orgId, n, { maxPreviewHours: 24 });
					await insertPolicyGroup(db, g);
					return [n, g.id] as const;
				})
			)
		);
		const base = { organizationId: orgId, by: 'u', at: 1 };
		const put = (
			n: string,
			kind: 'organization' | 'department' | 'site' | 'classification',
			t: string
		) => addAssignment(db, { ...base, groupId: groups[n]!, kind, targetId: t });
		await put('org', 'organization', orgId);
		await put('top', 'department', top.id);
		await put('low', 'department', low.id);
		await put('site', 'site', s);
		await put('label', 'classification', 'restricted');
		const got = await loadPolicyFor(db, { orgId, siteId: s });
		expect(got.map((g) => g.name)).toEqual(['org', 'top', 'low', 'site', 'label']);
		expect(
			(await loadPolicyFor(db, { orgId, departmentId: top.id })).map((g) => g.name)
		).toEqual(['org', 'top']);
		expect((await loadPolicyFor(db, { orgId })).map((g) => g.name)).toEqual(['org']);
		const plain = await site(orgId);
		expect((await loadPolicyFor(db, { orgId, siteId: plain })).map((g) => g.name)).toEqual([
			'org'
		]);
	});

	it('costs nothing and returns nothing for an organisation with no groups', async () => {
		const { orgId } = await organisation();
		expect(await loadPolicyFor(db, { orgId })).toEqual([]);
	});

	it('does not carry one organisation policy into another', async () => {
		const a = await organisation();
		const b = await organisation();
		const g = row(a.orgId, 'A only');
		await insertPolicyGroup(db, g);
		await addAssignment(db, {
			organizationId: a.orgId,
			groupId: g.id,
			kind: 'organization',
			targetId: a.orgId,
			by: 'u',
			at: 1
		});
		expect(await loadPolicyFor(db, { orgId: b.orgId })).toEqual([]);
	});

	it('runs a named check against the stack and throws the refusal with the group named', async () => {
		const { orgId } = await organisation();
		const g = row(orgId, 'No Legacy', { forbiddenTemplates: ['legacy'] });
		await insertPolicyGroup(db, g);
		await addAssignment(db, {
			organizationId: orgId,
			groupId: g.id,
			kind: 'organization',
			targetId: orgId,
			by: 'u',
			at: 1
		});
		await expect(
			assertPolicy(db, { orgId }, (groups) => checkTemplate(groups, { template: 'legacy' }))
		).rejects.toMatchObject({
			code: 'forbidden',
			details: {
				requires: 'policy',
				policy: g.id,
				policyName: 'No Legacy',
				rule: 'forbidden-templates'
			}
		});
		await assertPolicy(db, { orgId }, (groups) =>
			checkTemplate(groups, { template: 'modern' })
		);
	});
});

describe('the service', () => {
	it('creates, updates and lists, writing an audit row for each change', async () => {
		const { orgId, founder } = await organisation();
		const actor = actorFor(founder.id);
		const made = await createPolicy(services, orgId, actor, {
			name: 'Regulated',
			rules: { stepUpActions: ['site.transfer'] }
		});
		await updatePolicy(services, orgId, actor, made.id, {
			name: 'Regulated sites',
			rules: { maxPreviewHours: 12 }
		});
		const list = await listPolicies(services, orgId);
		expect(list.items).toHaveLength(1);
		expect(list.items[0]).toMatchObject({
			name: 'Regulated sites',
			rules: { maxPreviewHours: 12 }
		});
		expect(list.classifications.map((c) => c.label)).toEqual([
			'public',
			'internal',
			'restricted',
			'regulated'
		]);
		const mine = audits.filter((a) => a.orgId === orgId).map((a) => a.action);
		expect(mine).toEqual(['policy.created', 'policy.updated']);
		await expect(
			createPolicy(services, orgId, actor, { name: 'regulated SITES', rules: {} })
		).rejects.toMatchObject({ code: 'conflict' });
	});

	it('refuses to delete a group while it is assigned, then deletes it', async () => {
		const { orgId, founder } = await organisation();
		const actor = actorFor(founder.id);
		const made = await createPolicy(services, orgId, actor, { name: 'In Use', rules: {} });
		await assignPolicy(services, orgId, actor, made.id, {
			kind: 'organization',
			targetId: orgId
		});
		await expect(deletePolicy(services, orgId, actor, made.id)).rejects.toMatchObject({
			code: 'conflict',
			details: { reason: 'assigned' }
		});
		await unassignPolicy(services, orgId, actor, made.id, {
			kind: 'organization',
			targetId: orgId
		});
		await deletePolicy(services, orgId, actor, made.id);
		expect((await listPolicies(services, orgId)).items).toEqual([]);
		expect(audits.filter((a) => a.orgId === orgId).map((a) => a.action)).toEqual([
			'policy.created',
			'policy.assigned',
			'policy.unassigned',
			'policy.deleted'
		]);
	});

	it('assigns only to targets inside the organisation', async () => {
		const a = await organisation();
		const b = await organisation();
		const actor = actorFor(a.founder.id);
		const made = await createPolicy(services, a.orgId, actor, { name: 'Local', rules: {} });
		const foreignDept = dept(b.orgId, 'Theirs');
		await insertDepartment(db, foreignDept);
		const foreignSite = await site(b.orgId);
		for (const target of [
			{ kind: 'department' as const, targetId: foreignDept.id },
			{ kind: 'site' as const, targetId: foreignSite },
			{ kind: 'organization' as const, targetId: b.orgId },
			{ kind: 'classification' as const, targetId: 'secret' }
		]) {
			await expect(
				assignPolicy(services, a.orgId, actor, made.id, target)
			).rejects.toMatchObject({
				code: 'validation'
			});
		}
		const mine = dept(a.orgId, 'Mine');
		await insertDepartment(db, mine);
		const ok = await assignPolicy(services, a.orgId, actor, made.id, {
			kind: 'department',
			targetId: mine.id
		});
		expect(ok.assignments).toEqual([{ kind: 'department', targetId: mine.id }]);
	});

	it('answers another organisation group id as not found on every change', async () => {
		const a = await organisation();
		const b = await organisation();
		const made = await createPolicy(services, a.orgId, actorFor(a.founder.id), {
			name: 'Private',
			rules: {}
		});
		const intruder = actorFor(b.founder.id);
		const calls = [
			() => updatePolicy(services, b.orgId, intruder, made.id, { name: 'x', rules: {} }),
			() => deletePolicy(services, b.orgId, intruder, made.id),
			() =>
				assignPolicy(services, b.orgId, intruder, made.id, {
					kind: 'organization',
					targetId: b.orgId
				}),
			() =>
				unassignPolicy(services, b.orgId, intruder, made.id, {
					kind: 'organization',
					targetId: b.orgId
				})
		];
		for (const call of calls) {
			await expect(call()).rejects.toMatchObject({ code: 'not_found' });
		}
		expect((await listPolicies(services, a.orgId)).items).toHaveLength(1);
	});

	it('labels a site, audits the change and refuses a site from another organisation', async () => {
		const a = await organisation();
		const b = await organisation();
		const actor = actorFor(a.founder.id);
		const s = await site(a.orgId);
		expect(await classifySite(services, a.orgId, actor, s, 'regulated')).toEqual({
			siteId: s,
			classification: 'regulated'
		});
		expect(await siteClassification(services, a.orgId, s)).toMatchObject({
			classification: 'regulated'
		});
		await classifySite(services, a.orgId, actor, s, 'regulated');
		expect(audits.filter((x) => x.target === s)).toHaveLength(1);
		await expect(
			classifySite(services, b.orgId, actorFor(b.founder.id), s, 'public')
		).rejects.toMatchObject({
			code: 'not_found'
		});
		await expect(siteClassification(services, b.orgId, s)).rejects.toBeInstanceOf(ApiError);
		await classifySite(services, a.orgId, actor, s, null);
		expect((await siteClassification(services, a.orgId, s)).classification).toBeNull();
	});

	it('names a label and lists the default group a label picked', async () => {
		const { orgId, founder } = await organisation();
		const actor = actorFor(founder.id);
		const made = await createPolicy(services, orgId, actor, { name: 'DISC 3', rules: {} });
		await assignPolicy(services, orgId, actor, made.id, {
			kind: 'classification',
			targetId: 'regulated'
		});
		const list = await setClassificationDisplayName(
			services,
			orgId,
			actor,
			'regulated',
			'DISC 3'
		);
		expect(list.classifications.find((c) => c.label === 'regulated')).toEqual({
			label: 'regulated',
			displayName: 'DISC 3',
			policyId: made.id
		});
		const cleared = await setClassificationDisplayName(
			services,
			orgId,
			actor,
			'regulated',
			null
		);
		expect(
			cleared.classifications.find((c) => c.label === 'regulated')?.displayName
		).toBeNull();
	});
});

describe('the facts loader and authorize', () => {
	it('loads the stack for a site request and caps a grant above policy', async () => {
		const { orgId, founder } = await organisation();
		const s = await site(orgId, { classification: 'restricted' });
		const actor = actorFor(founder.id);
		const made = await createPolicy(services, orgId, actor, {
			name: 'Restricted default',
			rules: { blockedActions: ['site.deploy'] }
		});
		await assignPolicy(services, orgId, actor, made.id, {
			kind: 'classification',
			targetId: 'restricted'
		});
		const deps = {
			store: collegeFactsStore(async () => db),
			policy: async (input: { orgId: string; siteId?: string; departmentId?: string }) =>
				loadPolicyFor(db, input)
		};
		const loaded = await loadFacts(deps, {
			principal: asUser(founder.id),
			scope: 'site',
			action: 'site.deploy',
			params: { id: s, orgId }
		});
		expect(loaded?.facts.policy.map((g) => g.id)).toEqual([made.id]);
		const decision = authorize({
			principal: asUser(founder.id),
			action: 'site.deploy',
			resource: loaded!.resource,
			facts: loaded!.facts as Facts
		});
		expect(decision).toMatchObject({
			allow: false,
			reason: 'policy_denied',
			detail: { policy: made.id, policyName: 'Restricted default', rule: 'blocked-actions' }
		});
		const read = authorize({
			principal: asUser(founder.id),
			action: 'site.read',
			resource: loaded!.resource,
			facts: loaded!.facts as Facts
		});
		expect(read.allow).toBe(true);
	});
});

describe('the operation preflight', () => {
	function operation(orgId: string, siteId: string, over: Record<string, unknown> = {}) {
		const id = `op_${tag()}`;
		return {
			id,
			organizationId: orgId,
			accountId: 'acct',
			siteId,
			type: 'module.install' as const,
			status: 'planned' as const,
			idempotencyKey: `k-${id}`,
			targetIds: [siteId],
			preconditions: [],
			planDigest: 'digest',
			blastRadius: { sites: 1, destructiveSites: 0, productionDeploys: 0 },
			rollbackPoint: null,
			verification: 'pending' as const,
			budget: DEFAULT_CHANGE_BUDGET,
			steps: [{ id: 'one', name: 'One' }],
			inputs: { name: 'devel' },
			now: Date.UTC(2026, 10, 22, 3),
			...over
		};
	}

	it('fails a blocked start before anything is recorded, and starts when the policy is lifted', async () => {
		const { orgId, founder } = await organisation();
		const s = await site(orgId);
		const actor = actorFor(founder.id);
		const made = await createPolicy(services, orgId, actor, {
			name: 'No Devel',
			rules: { moduleDeny: ['devel'] }
		});
		await assignPolicy(services, orgId, actor, made.id, {
			kind: 'organization',
			targetId: orgId
		});
		const blocked = operation(orgId, s);
		await expect(createOperationRecord(db, blocked)).rejects.toMatchObject({
			code: 'forbidden',
			details: {
				requires: 'policy',
				policy: made.id,
				policyName: 'No Devel',
				rule: 'modules'
			}
		});
		const written = await db.first<{ n: number }>(
			orgId,
			'SELECT COUNT(*) AS n FROM operations WHERE id = ?',
			[blocked.id]
		);
		expect(written?.n).toBe(0);
		const fine = operation(orgId, s, { inputs: { name: 'views' } });
		expect((await createOperationRecord(db, fine)).created).toBe(true);
		await unassignPolicy(services, orgId, actor, made.id, {
			kind: 'organization',
			targetId: orgId
		});
		expect((await createOperationRecord(db, operation(orgId, s))).created).toBe(true);
	});

	it('blocks an upgrade outside the window by the site department policy only', async () => {
		const { orgId, founder } = await organisation();
		const d = dept(orgId, 'Library');
		await insertDepartment(db, d);
		const inside = await site(orgId, { departmentId: d.id });
		const outside = await site(orgId);
		const actor = actorFor(founder.id);
		const made = await createPolicy(services, orgId, actor, {
			name: 'Windows',
			rules: { maintenanceWindows: [{ days: [0], startHour: 2, hours: 4 }] }
		});
		await assignPolicy(services, orgId, actor, made.id, { kind: 'department', targetId: d.id });
		const late = { type: 'site.upgrade' as const, inputs: {}, now: Date.UTC(2026, 10, 25, 3) };
		await expect(
			createOperationRecord(db, operation(orgId, inside, late))
		).rejects.toMatchObject({
			details: { rule: 'maintenance-window' }
		});
		expect((await createOperationRecord(db, operation(orgId, outside, late))).created).toBe(
			true
		);
		const early = { type: 'site.upgrade' as const, inputs: {}, now: Date.UTC(2026, 10, 22, 3) };
		expect((await createOperationRecord(db, operation(orgId, inside, early))).created).toBe(
			true
		);
	});

	it('lets a repeated key return the first operation even after a policy lands', async () => {
		const { orgId, founder } = await organisation();
		const s = await site(orgId);
		const first = operation(orgId, s, { inputs: { name: 'views' } });
		await createOperationRecord(db, first);
		const actor = actorFor(founder.id);
		const made = await createPolicy(services, orgId, actor, {
			name: 'Allow none',
			rules: { moduleAllow: ['pathauto'] }
		});
		await assignPolicy(services, orgId, actor, made.id, {
			kind: 'organization',
			targetId: orgId
		});
		const again = await createOperationRecord(db, { ...first, id: `op_${tag()}` });
		expect(again.created).toBe(false);
	});
});
