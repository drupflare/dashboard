import { newId } from '@contracts/common';
import { DEFAULT_CHANGE_BUDGET, computePlanDigest } from '@contracts/operations';
import { categoryOfKind, type SiteKind } from '@contracts/sites';
import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	planSiteCleanup,
	type CleanupTarget,
	type SiteCleanupInput
} from '../../../engine/src/workflows/site-cleanup';
import { planSiteCreate, type SiteCreateInput } from '../../../engine/src/workflows/site-create';
import { planSiteDelete, type SiteDeleteInput } from '../../../engine/src/workflows/site-delete';
import { planSiteUpgrade, type SiteUpgradeInput } from '../../../engine/src/workflows/site-upgrade';
import { ApiError } from '../../shared/errors';
import { isValidName, suffixOwner } from '../../shared/names';
import type { BudgetKey } from '../../shared/permissions';
import { recipeFor } from '../../shared/recipes';
import { nowUtc } from '../../shared/utils/time';
import { createOperationRecord } from '../db/repos/backups';
import { getUserById } from '../db/repos/identity';
import {
	createSiteOperation,
	findOpenSiteOperation,
	getOperation,
	getOperationByKey,
	getOperationInputs,
	listOperationsForSite,
	openBlastRadius,
	updateOperationStatus,
	type StoredOperation
} from '../db/repos/operations';
import { listUserOrganizations } from '../db/repos/organization';
import {
	countOrganizationSites,
	getReadySite,
	getSite,
	setSiteState,
	toSite,
	type SiteRecord
} from '../db/repos/sites';
import { FREE_PLAN_ID, check, type CheckDenial, type Entitlement } from '../domain/entitlements';
import type { EngineStartRequest } from '../integrations/engine';
import { EngineStartError } from '../integrations/engine';
import { entitlementOf, type BillingStore } from './billing';
import { removeBoxSite } from './box-sites';
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
	// whether the organisation has a Stripe customer, which is what the billing portal needs
	billingAccountOf: (orgId: string) => Promise<boolean>;
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
		billingAccountOf: notBuilt('The billing account read'),
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
			const platformAdmin = (await getUserById(db, userId))?.platformRole === 'admin';
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
				platformAdmin,
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

export function entitlementRefusal(reason: CheckDenial): ApiError {
	return new ApiError('forbidden', 'Your plan does not include this kind of site', {
		requires: 'entitlement',
		feature: 'site.create',
		reason
	});
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
	if (!decision.allow) throw entitlementRefusal(decision.reason);

	const siteId = newId('site');
	const operationId = newId('op');
	const { config } = services;
	const category = categoryOfKind(input.kind);
	// the address comes from the stored user, never from the request body
	const owner = await getUserById(await services.getDb(), input.userId);
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
		hostSuffix: config.hostSuffix,
		labelSuffix: config.labelSuffix,
		...(owner === null ? {} : { ownerEmail: owner.email })
	}).catch(inputRefusal);
	return recordAndStartCreate(services, engineInput, {
		orgId: input.orgId,
		idempotencyKey: input.idempotencyKey
	});
}

// writes the operation and the hidden site row, then starts the engine; a retry carries the id of
// the failed create it replaces
export async function recordAndStartCreate(
	services: SiteServices,
	engineInput: SiteCreateInput,
	options: { orgId: string; idempotencyKey: string; retryOf?: string }
): Promise<StoredOperation> {
	const { orgId } = options;
	const siteId = engineInput.site.id;
	const operationId = engineInput.operationId;
	// the engine's own plan, so both writers hold one digest and one step list
	const plan = planSiteCreate(engineInput);
	const db = await services.getDb();
	const { operation, created } = await createSiteOperation(
		db,
		{
			id: siteId,
			organizationId: orgId,
			name: engineInput.site.name,
			kind: engineInput.site.kind,
			category: engineInput.site.category,
			plane: 'managed',
			config: engineInput.site.config,
			primaryHostname: engineInput.hostname,
			now: nowUtc().toMillis()
		},
		{
			id: operationId,
			organizationId: orgId,
			accountId: engineInput.site.accountId,
			siteId,
			type: 'site.create',
			status: 'planned',
			idempotencyKey: options.idempotencyKey,
			targetIds: plan.targetIds,
			preconditions: plan.preconditions,
			planDigest: await computePlanDigest(plan),
			blastRadius: plan.blastRadius,
			rollbackPoint: plan.rollbackPoint,
			verification: 'pending',
			budget: DEFAULT_CHANGE_BUDGET,
			steps: plan.steps,
			retryOf: options.retryOf ?? null,
			inputs: engineInput,
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
		await updateOperationStatus(db, orgId, operationId, operation.version, 'failed', now);
		await setSiteState(db, orgId, siteId, 'deleted', now);
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The site could not be started', {
			operationId,
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}

	const latest = await getOperation(db, orgId, operationId);
	if (!latest) throw new Error(`operation ${operationId} is missing after its start`);
	return latest;
}

// #region delete

export interface DeleteSiteInput {
	orgId: string;
	siteId: string;
	confirm: string;
	idempotencyKey: string;
}

const LIVE_STATES: readonly string[] = ['active', 'suspended'];

// the site stops serving when the engine tombstones it; this only records the request and starts it
export async function deleteSite(
	services: SiteServices,
	input: DeleteSiteInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	// a repeat must answer before the site lookup, since the site may already be gone by then
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'site.delete' ||
			known.operation.targetIds[0] !== input.siteId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.plane === 'self-hosted') return removeBoxSite(db, site, input);
	if (!LIVE_STATES.includes(site.state) || site.accountId === null) {
		throw new ApiError('unprocessable', 'This site is already deleted', {
			reason: 'site_not_live'
		});
	}
	if (input.confirm !== site.name) {
		throw new ApiError('unprocessable', 'The name you typed does not match this site', {
			reason: 'confirm_mismatch'
		});
	}
	const busy = await findOpenSiteOperation(db, input.orgId, site.id);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{
				reason: 'site_busy',
				operationId: busy.id,
				operation: busy.type
			}
		);
	}

	const operationId = newId('op');
	const params: SiteDeleteInput = {
		operationId,
		siteId: site.id,
		accountId: site.accountId,
		hostnames: toSite(site).hostnames
	};
	const plan = planSiteDelete(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'site.delete',
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: plan.targetIds,
		preconditions: plan.preconditions,
		planDigest: await computePlanDigest(plan),
		blastRadius: plan.blastRadius,
		rollbackPoint: plan.rollbackPoint,
		verification: 'not-required',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: plan.steps,
		now: nowUtc().toMillis()
	});
	if (!created) return operation;

	try {
		await services.startOperation({
			workflow: 'site-delete',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		});
	} catch (error) {
		// the engine never took it, so the site is untouched and the operation ends here
		await updateOperationStatus(
			db,
			input.orgId,
			operationId,
			operation.version,
			'failed',
			nowUtc().toMillis()
		);
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The delete could not be started', {
			operationId,
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}
	const latest = await getOperation(db, input.orgId, operationId);
	if (!latest) throw new Error(`operation ${operationId} is missing after its start`);
	return latest;
}

// #endregion

// #region upgrade

export interface UpgradeSiteInput {
	orgId: string;
	siteId: string;
	idempotencyKey: string;
}

// the engine owns every status after it accepts the start; the site keeps serving the release it
// runs until the engine's own upload replaces it
export async function upgradeSite(
	services: SiteServices,
	input: UpgradeSiteInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'site.upgrade' ||
			known.operation.targetIds[0] !== input.siteId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (
		site.state !== 'active' ||
		site.plane !== 'managed' ||
		site.accountId === null ||
		site.primaryHostname === null
	) {
		throw new ApiError('unprocessable', 'This site is not live, so it cannot be updated', {
			reason: 'site_not_live'
		});
	}
	const available = services.config.releases[site.kind];
	if (available === undefined) {
		throw new ApiError('not_built', `No current release is set for ${site.kind}`);
	}
	if (site.releaseId === available) {
		throw new ApiError('conflict', 'This site already runs the current release', {
			reason: 'up_to_date',
			release: available
		});
	}
	const recipe = recipeFor(site.kind);
	if (recipe === undefined) {
		throw new ApiError('unprocessable', `There is no recipe for ${site.kind}`, {
			reason: 'no_recipe'
		});
	}
	const busy = await findOpenSiteOperation(db, input.orgId, site.id);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{
				reason: 'site_busy',
				operationId: busy.id,
				operation: busy.type
			}
		);
	}

	const operationId = newId('op');
	const params: SiteUpgradeInput = {
		operationId,
		site: {
			id: site.id,
			orgId: input.orgId,
			kind: site.kind,
			plane: site.plane,
			config: site.config,
			ring: 'R0',
			plan: (await services.planOf(input.orgId)).planId,
			accountId: site.accountId
		},
		hostname: site.primaryHostname,
		releaseId: available,
		currentRelease: site.releaseId,
		probe: {
			path: recipe.probe.path,
			expectStatus: 200,
			...(recipe.probe.auth === undefined ? {} : { auth: recipe.probe.auth })
		}
	};
	const plan = planSiteUpgrade(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: site.accountId,
		siteId: site.id,
		type: 'site.upgrade',
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
		inputs: params,
		now: nowUtc().toMillis()
	});
	if (!created) return operation;

	try {
		await services.startOperation({
			workflow: 'site-upgrade',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		});
	} catch (error) {
		// the engine never took it, so the site is untouched and the operation ends here
		await updateOperationStatus(
			db,
			input.orgId,
			operationId,
			operation.version,
			'failed',
			nowUtc().toMillis()
		);
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', 'The update could not be started', {
			operationId,
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}
	const latest = await getOperation(db, input.orgId, operationId);
	if (!latest) throw new Error(`operation ${operationId} is missing after its start`);
	return latest;
}

// #endregion

// #region cleanup

export interface CleanupSiteInput {
	orgId: string;
	siteId: string;
	idempotencyKey: string;
	retryOf?: string;
}

// the engine owns every status after it accepts the start; a refused start is the dashboard's to close
export async function startRecorded(
	services: SiteServices,
	db: CollegeDBClient,
	orgId: string,
	operation: StoredOperation,
	request: EngineStartRequest,
	refusal: string
): Promise<StoredOperation> {
	try {
		await services.startOperation(request);
	} catch (error) {
		await updateOperationStatus(
			db,
			orgId,
			request.id,
			operation.version,
			'failed',
			nowUtc().toMillis()
		);
		if (error instanceof ApiError) throw error;
		throw new ApiError('unprocessable', refusal, {
			operationId: request.id,
			...(error instanceof EngineStartError ? { reason: error.code } : {})
		});
	}
	const latest = await getOperation(db, orgId, request.id);
	if (!latest) throw new Error(`operation ${request.id} is missing after its start`);
	return latest;
}

// the managed label is the host's first label less the staging suffix
function subdomainOf(hostname: string, labelSuffix: string | undefined): string {
	const label = hostname.split('.')[0] ?? hostname;
	return labelSuffix && label.endsWith(labelSuffix) ? label.slice(0, -labelSuffix.length) : label;
}

// what the failed create recorded about its site, with the site row and the config as the fallback
async function cleanupTargetOf(
	services: SiteServices,
	db: CollegeDBClient,
	site: SiteRecord,
	creates: StoredOperation | undefined
): Promise<CleanupTarget> {
	const recorded = creates
		? ((await getOperationInputs(db, site.organizationId, creates.operation.id)) as Partial<
				Pick<SiteCreateInput, 'site' | 'hostname' | 'subdomain'>
			> | null)
		: null;
	const hostname = recorded?.hostname ?? site.primaryHostname;
	const accountId = recorded?.site?.accountId ?? services.config.accountId;
	if (hostname === null || hostname === undefined || !accountId) {
		throw new ApiError('not_built', 'This site was not recorded well enough to clean up');
	}
	return {
		siteId: site.id,
		accountId,
		plane: site.plane,
		hostname,
		subdomain: recorded?.subdomain ?? subdomainOf(hostname, services.config.labelSuffix)
	};
}

// a site whose create never finished: whatever the create left is removed and the name is freed.
// A site that is deleted already has nothing left, so a repeat returns the operation that did it
export async function cleanupSite(
	services: SiteServices,
	input: CleanupSiteInput
): Promise<StoredOperation> {
	const db = await services.getDb();
	const known = await getOperationByKey(db, input.orgId, input.idempotencyKey);
	if (known) {
		if (
			known.operation.type !== 'repair.run' ||
			known.operation.targetIds[0] !== input.siteId
		) {
			throw new ApiError('conflict', 'This Idempotency-Key belongs to a different request', {
				reason: 'idempotency_key_reused'
			});
		}
		return known;
	}
	const site = await getSite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.readyAt !== null && site.state !== 'deleted') {
		throw new ApiError('conflict', 'This site is live, so it is not cleaned up', {
			reason: 'site_active'
		});
	}
	const busy = await findOpenSiteOperation(db, input.orgId, site.id);
	if (busy) {
		throw new ApiError(
			'conflict',
			'Another change to this site is still running. Wait for it to finish.',
			{ reason: 'site_busy', operationId: busy.id, operation: busy.type }
		);
	}
	const history = await listOperationsForSite(db, input.orgId, site.id, { count: 50 });
	if (site.state === 'deleted') {
		const settled =
			history.find(
				(row) => row.operation.type === 'repair.run' && row.operation.status === 'succeeded'
			) ?? history[0];
		if (!settled) throw new ApiError('not_found', 'Not found');
		return settled;
	}

	const target = await cleanupTargetOf(
		services,
		db,
		site,
		history.find((row) => row.operation.type === 'site.create')
	);
	const operationId = newId('op');
	const params: SiteCleanupInput = { operationId, ...target };
	const plan = planSiteCleanup(params);
	const { operation, created } = await createOperationRecord(db, {
		id: operationId,
		organizationId: input.orgId,
		accountId: target.accountId,
		siteId: site.id,
		type: 'repair.run',
		status: 'planned',
		idempotencyKey: input.idempotencyKey,
		targetIds: plan.targetIds,
		preconditions: plan.preconditions,
		planDigest: await computePlanDigest(plan),
		blastRadius: plan.blastRadius,
		rollbackPoint: plan.rollbackPoint,
		verification: 'not-required',
		budget: DEFAULT_CHANGE_BUDGET,
		steps: plan.steps,
		retryOf: input.retryOf ?? null,
		inputs: params,
		now: nowUtc().toMillis()
	});
	if (!created) return operation;
	return startRecorded(
		services,
		db,
		input.orgId,
		operation,
		{
			workflow: 'site-cleanup',
			id: operationId,
			params: params as unknown as Record<string, unknown>
		},
		'The cleanup could not be started'
	);
}

// #endregion
