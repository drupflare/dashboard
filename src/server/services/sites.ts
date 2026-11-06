import { newId } from '@contracts/common';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest } from '@contracts/operations';
import { categoryOfKind, type SiteKind } from '@contracts/sites';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { planSiteCreate } from '../../../engine/src/workflows/site-create';
import { ApiError } from '../../shared/errors';
import { isValidName, suffixOwner } from '../../shared/names';
import type { BudgetKey } from '../../shared/permissions';
import { recipeFor } from '../../shared/recipes';
import { nowUtc } from '../../shared/utils/time';
import {
	createSiteOperation,
	getOperation,
	openBlastRadius,
	updateOperationStatus,
	type StoredOperation
} from '../db/repos/operations';
import { listUserOrganizations } from '../db/repos/organization';
import { countOrganizationSites, setSiteState } from '../db/repos/sites';
import { FREE_PLAN_ID, check, type CheckDenial, type Entitlement } from '../domain/entitlements';
import type { EngineStartRequest } from '../integrations/engine';
import { EngineStartError } from '../integrations/engine';
import { entitlementOf, type BillingStore } from './billing';
import {
	MANAGED_HOST_SUFFIX,
	SiteInputError,
	buildSiteCreateInput,
	type SiteInputConfig
} from './site-input';

export { MANAGED_HOST_SUFFIX };

export type EntitlementDecision =
	{ allow: true; entitlement: Entitlement } | { allow: false; reason: CheckDenial };

export interface SiteServices {
	getDb: () => Promise<CollegeDBClient>;
	entitlements: {
		check(input: {
			orgId: string;
			userId: string;
			kind: SiteKind;
		}): Promise<EntitlementDecision>;
	};
	planOf: (orgId: string) => Promise<Entitlement>;
	// resolves once the signed start request is accepted; it does not wait for the workflow
	startOperation: (request: EngineStartRequest) => Promise<void>;
	config: SiteInputConfig;
}

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

// every collaborator fails closed until a boot step installs the real one
function productionServices(): SiteServices {
	return {
		getDb: notBuilt('The site store'),
		entitlements: { check: notBuilt('The entitlement check') },
		planOf: notBuilt('The plan read'),
		startOperation: notBuilt('Starting an operation'),
		config: { hostSuffix: MANAGED_HOST_SUFFIX, accountId: null, releases: {} }
	};
}

let installed = productionServices();

export function setSiteServices(over: Partial<SiteServices>): void {
	installed = { ...installed, ...over };
}

export function resetSiteServices(): void {
	installed = productionServices();
}

export function siteServices(): SiteServices {
	return installed;
}

// #region entitlements and budgets

// the plan is the organisation's billing row, or Managed Free when it has none
export function collegeSiteEntitlements(
	getDb: () => Promise<CollegeDBClient>,
	billing: Pick<BillingStore, 'getAccount'>
): SiteServices['entitlements'] {
	const planOf = async (orgId: string) => entitlementOf(await billing.getAccount(orgId));
	return {
		async check({ orgId, userId, kind }) {
			const db = await getDb();
			const entitlement = await planOf(orgId);
			const sitesInOrg = await countOrganizationSites(db, orgId);
			let freeSitesOwnedByUser: number | undefined;
			if (entitlement.planId === FREE_PLAN_ID) {
				// free sites count per person, across every organisation they own on the free plan
				const owned = await listUserOrganizations(db, userId, { limit: 500 });
				let total = 0;
				for (const org of owned.items) {
					if (org.role !== 'owner') continue;
					if ((await planOf(org.id)).planId !== FREE_PLAN_ID) continue;
					total += await countOrganizationSites(db, org.id);
				}
				freeSitesOwnedByUser = Math.max(total, sitesInOrg);
			}
			const decision = check('site.create', entitlement, {
				sitesInOrg,
				freeSitesOwnedByUser,
				customWorker: kind === 'custom'
			});
			return decision.allow ? { allow: true, entitlement } : decision;
		}
	};
}

// a budget is spent when the running operations already use all of it
export function collegeBudgets(
	getDb: () => Promise<CollegeDBClient>
): (orgId: string) => Promise<BudgetKey[]> {
	return async (orgId) => {
		const load = await openBlastRadius(await getDb(), orgId);
		const spent: BudgetKey[] = [];
		if (load.destructiveSites >= DEFAULT_CHANGE_BUDGET.maxDestructiveSites) {
			spent.push('destructive-sites');
		}
		if (load.productionDeploys >= DEFAULT_CHANGE_BUDGET.maxConcurrentProductionDeploys) {
			spent.push('production-deploys');
		}
		return spent;
	};
}

// #endregion

export interface CreateSiteInput {
	orgId: string;
	userId: string;
	kind: SiteKind;
	name: string;
	hostnameLabel: string | undefined;
	idempotencyKey: string;
}

// the name authority is the engine's reserve-name step; this checks the format and reserved words only
function checkLabel(value: string, field: 'name' | 'hostnameLabel'): void {
	if (!isValidName(value)) {
		throw new ApiError('validation', `${field} does not follow the site name rules`, { field });
	}
	const owner = suffixOwner(value);
	if (owner !== null)
		throw new ApiError('unprocessable', `${field} is reserved`, { field, owner });
}

function inputRefusal(error: unknown): never {
	if (!(error instanceof SiteInputError)) throw error;
	if (error.code === 'no_account' || error.code === 'no_release') {
		throw new ApiError('not_built', error.message);
	}
	throw new ApiError('unprocessable', error.message, { reason: error.code });
}

// ready_at stays unset until the engine's activate step sets it, so reads leave the row out. The
// engine owns every status change after the start is accepted
export async function createSite(
	services: SiteServices,
	input: CreateSiteInput
): Promise<StoredOperation> {
	const label = input.hostnameLabel ?? input.name;
	checkLabel(input.name, 'name');
	checkLabel(label, 'hostnameLabel');
	const decision = await services.entitlements.check({
		orgId: input.orgId,
		userId: input.userId,
		kind: input.kind
	});
	if (!decision.allow) {
		throw new ApiError('forbidden', 'Your plan does not include this kind of site', {
			requires: 'entitlement',
			feature: 'site.create',
			reason: decision.reason
		});
	}

	const siteId = newId('site');
	const operationId = newId('op');
	const { config } = services;
	const category = categoryOfKind(input.kind);
	const engineInput = await buildSiteCreateInput({
		site: {
			id: siteId,
			name: input.name,
			kind: input.kind,
			category,
			plane: 'managed',
			label
		},
		organization: { id: input.orgId, planId: decision.entitlement.planId },
		operation: { id: operationId },
		recipe: recipeFor(input.kind),
		release: config.releases[input.kind],
		account: config.accountId,
		hostSuffix: config.hostSuffix
	}).catch(inputRefusal);

	// the engine's own plan, so both writers hold one digest and one step list
	const plan = planSiteCreate(engineInput);
	const db = await services.getDb();
	const { operation, created } = await createSiteOperation(
		db,
		{
			id: siteId,
			organizationId: input.orgId,
			name: input.name,
			kind: input.kind,
			category,
			plane: 'managed',
			config: engineInput.site.config,
			primaryHostname: engineInput.hostname,
			now: nowUtc().toMillis()
		},
		{
			id: operationId,
			organizationId: input.orgId,
			accountId: engineInput.site.accountId,
			siteId,
			type: 'site.create',
			status: 'planned',
			idempotencyKey: input.idempotencyKey,
			targetIds: plan.targetIds,
			preconditions: plan.preconditions,
			planDigest: await computePlanDigest(plan),
			blastRadius: plan.blastRadius,
			rollbackPoint: plan.rollbackPoint,
			verification: 'pending',
			budget: DEFAULT_CHANGE_BUDGET,
			steps: plan.steps,
			now: nowUtc().toMillis()
		}
	);
	if (!created) return operation;

	try {
		await services.startOperation({
			workflow: 'site-create',
			id: operationId,
			params: engineInput as unknown as Record<string, unknown>
		});
	} catch (error) {
		// the engine never took it, so no one else writes this operation or site
		const now = nowUtc().toMillis();
		await updateOperationStatus(db, input.orgId, operationId, operation.version, 'failed', now);
		await setSiteState(db, input.orgId, siteId, 'deleted', now);
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The site could not be started', {
			operationId,
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}

	const latest = await getOperation(db, input.orgId, operationId);
	if (!latest) throw new Error(`operation ${operationId} is missing after its start`);
	return latest;
}
