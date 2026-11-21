import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import type { BudgetKey } from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { listActiveDelegations } from '../db/repos/delegations';
import {
	getDepartment,
	getSiteDepartment,
	listDepartments,
	listUserDepartmentGrants
} from '../db/repos/departments';
import { listUserSiteGrants } from '../db/repos/grants';
import { getMember, getOrganization } from '../db/repos/organization';
import { findSiteHome } from '../db/repos/site-lookup';
import type {
	BreakGlass,
	Facts,
	Membership,
	Principal,
	Resource,
	SupportGrant
} from '../domain/authorize';
import { isActive, type Delegation } from '../domain/delegation';
import type { DepartmentNode } from '../domain/departments';
import type { Grant, PolicyGroup } from '../domain/policy';
import type { ApiKeyFacts } from '../domain/scopes';
import type { AccessIdentity } from '../utils/access';
import { keyFactsOf, stepUpAtOf } from '../utils/auth';
import type { Loaded, LoadInput } from '../utils/define-api';

// #region contracts

// one method per lookup, each keyed by what the caller already proved; nothing lists another
// person's membership
export interface FactsStore {
	organization(id: string): Promise<{ id: string } | null>;
	site(id: string): Promise<{ id: string; orgId: string } | null>;
	member(orgId: string, userId: string): Promise<Membership | null>;
	siteGrants(orgId: string, userId: string): Promise<readonly Grant[]>;
	delegations(clientOrgId: string): Promise<readonly Delegation[]>;
	// departments are optional so a store that predates them still loads; a route that names a
	// department fails closed without `department`
	department?(orgId: string, id: string): Promise<{ id: string } | null>;
	departments?(orgId: string): Promise<readonly DepartmentNode[]>;
	departmentGrants?(orgId: string, userId: string): Promise<readonly Grant[]>;
	siteDepartment?(orgId: string, siteId: string): Promise<string | null>;
}

export interface SupportStanding {
	platform?: NonNullable<Facts['platform']>;
	supportGrant?: SupportGrant;
	breakGlass?: BreakGlass;
}

export interface Suspensions {
	orgIds: readonly string[];
	user: boolean;
}

// every port defaults to empty: no entitlement, no spent budget, no policy group, nobody suspended
// and no platform standing. The billing and operations work wires the real ones
export interface FactsDeps {
	store: FactsStore;
	entitlements?(orgId: string): Promise<readonly string[]>;
	budgets?(orgId: string): Promise<readonly BudgetKey[]>;
	policy?(input: {
		orgId: string;
		siteId?: string;
		departmentId?: string;
	}): Promise<readonly PolicyGroup[]>;
	suspensions?(input: { orgIds: readonly string[]; userId: string }): Promise<Suspensions>;
	support?(input: {
		userId: string;
		orgId: string;
		access: AccessIdentity | null;
	}): Promise<SupportStanding | null>;
	// the platform standing of a signed-in person: their role and whether Access vouched for them
	platform?(input: {
		userId: string;
		access: AccessIdentity | null;
	}): Promise<NonNullable<Facts['platform']> | null>;
}

// #endregion

// #region store

export function collegeFactsStore(getDb: () => Promise<CollegeDBClient>): FactsStore {
	return {
		async organization(id) {
			const org = await getOrganization(await getDb(), id);
			return org ? { id: org.id } : null;
		},
		async site(id) {
			const home = await findSiteHome(await getDb(), id);
			return home ? { id: home.id, orgId: home.organizationId } : null;
		},
		async member(orgId, userId) {
			const member = await getMember(await getDb(), orgId, userId);
			return member ? { orgId: member.organizationId, role: member.role } : null;
		},
		async siteGrants(orgId, userId) {
			return listUserSiteGrants(await getDb(), orgId, userId);
		},
		async delegations(clientOrgId) {
			return listActiveDelegations(await getDb(), clientOrgId);
		},
		async department(orgId, id) {
			const row = await getDepartment(await getDb(), orgId, id);
			return row ? { id: row.id } : null;
		},
		async departments(orgId) {
			const rows = await listDepartments(await getDb(), orgId);
			return rows.map((row) => ({ id: row.id, parentId: row.parentId, kind: row.kind }));
		},
		async departmentGrants(orgId, userId) {
			return listUserDepartmentGrants(await getDb(), orgId, userId);
		},
		async siteDepartment(orgId, siteId) {
			return (await getSiteDepartment(await getDb(), orgId, siteId))?.departmentId ?? null;
		}
	};
}

// #endregion

// #region loader

// a path value is a lookup key and never an answer: ids are lower case, so a stray space or capital
// finds the same row and the row's own id is what goes on the resource
export const lookupKey = (value: unknown): string =>
	typeof value === 'string' ? value.trim().toLowerCase() : '';

function sessionFacts(principal: Principal, now: number): Loaded | null {
	const facts: Facts = {
		now,
		flags: {},
		grants: [],
		agencyMemberships: [],
		delegations: [],
		policy: [],
		entitlements: [],
		budgetExceeded: []
	};
	const stepUpAt = stepUpAtOf(principal);
	if (stepUpAt !== undefined) facts.stepUpAt = stepUpAt;
	if (principal.kind === 'key') {
		const key = keyFactsOf(principal);
		if (!key) return null;
		facts.key = key;
	}
	return { resource: {}, facts };
}

// the key's own record as it stands at this moment; a key the resolver never saw has none
function liveKey(principal: Principal, now: number): ApiKeyFacts | null {
	const key = keyFactsOf(principal);
	if (!key) return null;
	if (key.revokedAt !== undefined && key.revokedAt <= now) return null;
	if (key.expiresAt !== undefined && key.expiresAt <= now) return null;
	return key;
}

async function locate(
	store: FactsStore,
	scope: 'organization' | 'site',
	params: Record<string, string>
): Promise<Resource | null> {
	if (scope === 'organization') {
		const key = lookupKey(params.orgId);
		if (key === '') return null;
		const org = await store.organization(key);
		if (!org) return null;
		if (params.deptId === undefined) return { orgId: org.id };
		// the department is read inside this organisation, so another organisation's id finds nothing
		const department = await store.department?.(org.id, lookupKey(params.deptId));
		return department ? { orgId: org.id, departmentId: department.id } : null;
	}
	const key = lookupKey(params.id);
	if (key === '') return null;
	const site = await store.site(key);
	if (!site) return null;
	// a path that also names an organisation can only narrow the answer, never choose it
	if (params.orgId !== undefined && lookupKey(params.orgId) !== lookupKey(site.orgId))
		return null;
	const org = await store.organization(site.orgId);
	if (!org) return null;
	const departmentId = await store.siteDepartment?.(org.id, site.id);
	return {
		orgId: org.id,
		siteId: site.id,
		...(departmentId ? { departmentId } : {})
	};
}

function supportReady(support: SupportStanding | null): support is SupportStanding {
	const platform = support?.platform;
	return (
		platform?.admin === true &&
		platform.access === true &&
		platform.permissions.includes('support')
	);
}

export async function loadFacts(deps: FactsDeps, input: LoadInput): Promise<Loaded | null> {
	const { principal, scope, params } = input;
	const now = nowUtc().toMillis();
	if (scope === 'session') return sessionFacts(principal, now);
	if (scope === 'admin') {
		if (principal.kind !== 'user') return null;
		const loaded = sessionFacts(principal, now);
		const platform = await deps.platform?.({
			userId: principal.userId,
			access: input.access ?? null
		});
		if (loaded && platform) loaded.facts.platform = platform;
		return loaded;
	}
	if (scope !== 'organization' && scope !== 'site') {
		throw new ApiError('not_built', 'The facts loader is not available for this scope yet');
	}

	const key = principal.kind === 'key' ? liveKey(principal, now) : undefined;
	if (key === null) return null;

	const { store } = deps;
	const resource = await locate(store, scope, params);
	if (!resource) return null;
	const orgId = resource.orgId as string;
	// for a key, every subject fact describes the person who issued it
	const userId = principal.kind === 'user' ? principal.userId : principal.issuerId;

	const [found, siteGrantRows, delegationRows, support, tree, departmentGrantRows] =
		await Promise.all([
			store.member(orgId, userId),
			store.siteGrants(orgId, userId),
			store.delegations(orgId),
			principal.kind === 'user' && deps.support
				? deps.support({ userId, orgId, access: input.access ?? null })
				: Promise.resolve(null),
			store.departments?.(orgId) ?? Promise.resolve([]),
			store.departmentGrants?.(orgId, userId) ?? Promise.resolve([])
		]);
	const membership = found?.orgId === orgId ? found : null;
	// a department role only counts while the person is still in the organisation
	const grantRows = [...siteGrantRows, ...(membership ? departmentGrantRows : [])];
	const grants = grantRows.filter((grant) => grant.orgId === orgId);
	const delegations = delegationRows.filter(
		(delegation) => delegation.clientOrgId === orgId && isActive(delegation, now)
	);
	const agencyIds = [...new Set(delegations.map((delegation) => delegation.agencyOrgId))];
	const agencyMemberships = (
		await Promise.all(agencyIds.map((agencyId) => store.member(agencyId, userId)))
	).filter((m): m is Membership => m !== null && agencyIds.includes(m.orgId));

	const acting =
		supportReady(support) &&
		((support.supportGrant?.orgId === orgId && support.supportGrant.expiresAt > now) ||
			support.breakGlass?.orgId === orgId);
	const related =
		membership !== null ||
		grants.length > 0 ||
		delegations.some((d) => agencyMemberships.some((m) => m.orgId === d.agencyOrgId)) ||
		acting;
	// no relationship reads nothing more about this organisation and answers as a missing one
	if (!related) return null;

	const watched = [orgId, ...agencyIds];
	const [suspended, entitlements, budgetExceeded, policy] = await Promise.all([
		deps.suspensions?.({ orgIds: watched, userId }) ?? { orgIds: [], user: false },
		deps.entitlements?.(orgId) ?? [],
		deps.budgets?.(orgId) ?? [],
		deps.policy?.({
			orgId,
			...(resource.siteId === undefined ? {} : { siteId: resource.siteId }),
			...(resource.departmentId === undefined ? {} : { departmentId: resource.departmentId })
		}) ?? []
	]);

	const facts: Facts = {
		now,
		flags: {
			...(suspended.user ? { userSuspended: true } : {}),
			suspendedOrgIds: suspended.orgIds.filter((id) => watched.includes(id))
		},
		grants,
		agencyMemberships,
		delegations,
		policy,
		entitlements,
		budgetExceeded
	};
	if (membership) facts.membership = membership;
	if (tree.length > 0) facts.departments = tree;
	const stepUpAt = stepUpAtOf(principal);
	if (stepUpAt !== undefined) facts.stepUpAt = stepUpAt;
	if (key) facts.key = key;
	if (support?.platform) facts.platform = support.platform;
	if (support?.supportGrant) facts.supportGrant = support.supportGrant;
	if (support?.breakGlass) facts.breakGlass = support.breakGlass;
	return { resource, facts };
}

export function factsLoader(deps: FactsDeps): (input: LoadInput) => Promise<Loaded | null> {
	return (input) => loadFacts(deps, input);
}

// #endregion
