import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { newBackupId } from '../../../engine/src/backup-parts';
import { planModuleEnable } from '../../../engine/src/workflows/module-enable';
import { planModuleInstall } from '../../../engine/src/workflows/module-install';
import { NEEDS_WORKER_UPDATE, planModuleRemove } from '../../../engine/src/workflows/module-remove';
import { NEEDS_THEME_UPDATE, planThemeDefault } from '../../../engine/src/workflows/theme-default';
import { ApiError } from '../../shared/errors';
import {
	installRefusal,
	machineName,
	moduleConflictSchema,
	parseModuleManifestValue,
	searchModules,
	type ModuleCheck,
	type ModuleListItem,
	type ModuleManifest,
	type ModuleQuery
} from '../../shared/modules';
import censusJson from '../../shared/modules.json';
import { restoreCeiling } from '../../shared/restore-limits';
import { getReadySite, type SiteRecord } from '../db/repos/sites';
import type { Principal } from '../domain/authorize';
import { guardRemoval } from '../domain/module-removal';
import { checkUrl, UrlGuardError, type FetchLike } from '../integrations/url-guard';
import { newOperation, startAndReturn, type BackupServices } from './backups';
import { principalActor, withOwnerToken, type CustodyDeps } from './owner-tokens';

export interface ModuleServices {
	getDb: () => Promise<CollegeDBClient>;
	custody: () => Promise<CustodyDeps>;
	fetch: FetchLike;
	timeoutMs: number;
	census: () => ModuleManifest;
	startOperation: BackupServices['startOperation'];
	// the worker routes that exist today; a removal or a theme change is refused until they do
	routes: { uninstall: boolean; themeDefault: boolean };
	restoreCeilingBytes: number;
}

export const MODULE_CHECK_TIMEOUT_MS = 5_000;

const notBuilt = (what: string) => async (): Promise<never> => {
	throw new ApiError('not_built', `${what} is not available yet`);
};

function productionServices(): ModuleServices {
	const census = parseModuleManifestValue(censusJson);
	return {
		getDb: notBuilt('The site store'),
		custody: notBuilt('Secret custody'),
		fetch: (input, init) => fetch(input, init),
		timeoutMs: MODULE_CHECK_TIMEOUT_MS,
		census: () => census,
		startOperation: notBuilt('Starting an operation'),
		routes: { uninstall: false, themeDefault: false },
		restoreCeilingBytes: restoreCeiling(false)
	};
}

let installed = productionServices();

export function setModuleServices(over: Partial<ModuleServices>): void {
	installed = { ...installed, ...over };
}

export function resetModuleServices(): void {
	installed = productionServices();
}

export function moduleServices(): ModuleServices {
	return installed;
}

export async function searchSiteModules(
	services: ModuleServices,
	input: { orgId: string; siteId: string; query: ModuleQuery }
): Promise<{ items: ModuleListItem[] }> {
	const site = await getReadySite(await services.getDb(), input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const items = searchModules(services.census(), input.query).map((row) => ({
		...row,
		// the worker has no route that lists installed modules, so the answer is unknown
		installed: null
	}));
	return { items };
}

function refuse(message: string): ModuleCheck {
	return { ok: false, conflicts: [], message };
}

// the worker's answer to /installable; a 404 or a tier the runtime refuses is named, not guessed
const workerVerdictSchema = z.object({
	verdict: z.enum(['installable', 'blocked', 'unverifiable', 'not-found']),
	conflicts: z.array(moduleConflictSchema).default([]),
	tier: z.string().optional(),
	reason: z.string().optional()
});

const UNREADABLE = 'The site answered in a form the dashboard could not read.';

async function classify(res: Response): Promise<ModuleCheck> {
	const { status } = res;
	if (status !== 200) void res.body?.cancel().catch(() => undefined);
	if (status === 404) return refuse('No release of this module was found.');
	if (status === 401 || status === 403) {
		return refuse('The site did not accept the access the dashboard holds for it.');
	}
	if (status >= 500) return refuse('The site answered with an error.');
	if (status !== 200) return refuse(UNREADABLE);
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return refuse(UNREADABLE);
	}
	const parsed = workerVerdictSchema.safeParse(body);
	if (!parsed.success) return refuse(UNREADABLE);
	const { verdict, tier, reason } = parsed.data;
	const conflicts = parsed.data.conflicts.map((c) => ({
		requires: c.requires,
		constraint: c.constraint,
		installed: c.installed,
		reason: c.reason
	}));
	if (verdict === 'not-found') return refuse('No release of this module was found.');
	if (verdict === 'unverifiable') {
		return {
			ok: false,
			conflicts,
			message:
				'The requirements of this module cannot be checked here, so it cannot be installed yet.'
		};
	}
	if (verdict === 'blocked') {
		return {
			ok: false,
			conflicts,
			message: 'Installing this module would conflict with the code the site already has.'
		};
	}
	if (tier === 'refused') {
		return refuse(reason ?? 'This site cannot run the module.');
	}
	return {
		ok: true,
		conflicts: [],
		message: 'No conflicts. The site can take this module.'
	};
}

export async function checkSiteModule(
	services: ModuleServices,
	input: { orgId: string; siteId: string; principal: Principal; name: string }
): Promise<ModuleCheck> {
	const site = await getReadySite(await services.getDb(), input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.kind !== 'drupal') return refuse('Module checks are for Drupal sites.');
	if (site.state !== 'active') {
		return refuse('This site is not active, so its modules cannot be checked.');
	}
	if (site.primaryHostname === null) return refuse('This site has no hostname yet.');

	const row = services.census().modules.find((candidate) => candidate.name === input.name);
	if (row === undefined) return refuse('That module is not on the list.');
	if (row.state === 'blocked') return refuse(row.reason ?? 'This module cannot run here.');

	let url: URL;
	try {
		url = new URL('/installable', checkUrl(`https://${site.primaryHostname}`));
	} catch (error) {
		if (!(error instanceof UrlGuardError)) throw error;
		return refuse('The hostname of this site is not valid.');
	}
	url.searchParams.set('module', input.name);

	try {
		return await withOwnerToken(
			await services.custody(),
			{ siteId: site.id, actor: principalActor(input.principal), operation: 'module.check' },
			async (token) => {
				let res: Response;
				try {
					res = await services.fetch(url.href, {
						method: 'GET',
						headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
						// a redirect would carry the token to another host
						redirect: 'manual',
						signal: AbortSignal.timeout(services.timeoutMs)
					});
				} catch {
					return refuse('The site did not answer.');
				}
				return classify(res);
			}
		);
	} catch (error) {
		if (error instanceof ApiError && error.code === 'not_found') {
			return refuse(
				'The dashboard holds no access for this site yet, so its modules cannot be checked.'
			);
		}
		throw error;
	}
}

// #region the changes

const notFound = () => new ApiError('not_found', 'Not found');

const refused = (message: string, reason: string, extra: Record<string, unknown> = {}) =>
	new ApiError('unprocessable', message, { reason, ...extra });

async function changeableSite(
	services: ModuleServices,
	orgId: string,
	siteId: string
): Promise<{ db: CollegeDBClient; site: SiteRecord & { accountId: string } }> {
	const db = await services.getDb();
	const site = await getReadySite(db, orgId, siteId);
	if (site === null) throw notFound();
	if (site.kind !== 'drupal') {
		throw refused('Module changes are for Drupal sites.', 'not_drupal');
	}
	if (site.state !== 'active' || site.accountId === null) {
		throw refused(
			'This site is not active, so its modules cannot be changed.',
			'site_not_active'
		);
	}
	return { db, site: { ...site, accountId: site.accountId } };
}

interface Change {
	orgId: string;
	siteId: string;
	idempotencyKey: string;
	operationId: string;
}

async function begin(
	services: ModuleServices,
	change: Change,
	spec: {
		type: 'module.install' | 'module.enable' | 'module.remove' | 'theme.default';
		workflow: 'module-install' | 'module-enable' | 'module-remove' | 'theme-default';
		plan: Parameters<typeof newOperation>[1]['plan'];
		params: object;
		site: SiteRecord & { accountId: string };
		db: CollegeDBClient;
	}
) {
	const { operation, created } = await newOperation(spec.db, {
		id: change.operationId,
		orgId: change.orgId,
		accountId: spec.site.accountId,
		siteId: spec.site.id,
		type: spec.type,
		plan: spec.plan,
		idempotencyKey: change.idempotencyKey,
		inputs: spec.params
	});
	if (!created) return operation;
	return startAndReturn(
		services,
		spec.db,
		operation,
		{
			workflow: spec.workflow,
			id: change.operationId,
			params: spec.params as Record<string, unknown>
		},
		change.orgId
	);
}

function baseParams(
	services: ModuleServices,
	change: Change,
	site: SiteRecord & { accountId: string },
	name: string
) {
	return {
		operationId: change.operationId,
		orgId: change.orgId,
		siteId: site.id,
		accountId: site.accountId,
		backupId: newBackupId(),
		name,
		restoreCeilingBytes: services.restoreCeilingBytes
	};
}

const rowOf = (services: ModuleServices, name: string) =>
	services.census().modules.find((candidate) => candidate.name === name) ?? null;

export async function installSiteModule(
	services: ModuleServices,
	input: Change & { name: string; confirm: boolean }
) {
	const { db, site } = await changeableSite(services, input.orgId, input.siteId);
	const census = rowOf(services, input.name);
	const refusal = installRefusal(census ?? undefined, input.confirm);
	if (refusal !== null) {
		throw refused(refusal, input.confirm ? 'module_refused' : 'needs_confirmation');
	}
	const params = {
		...baseParams(services, input, site, input.name),
		census: census && { state: census.state, shipping: census.shipping, reason: census.reason },
		confirm: input.confirm
	};
	return begin(services, input, {
		type: 'module.install',
		workflow: 'module-install',
		plan: planModuleInstall(params),
		params,
		site,
		db
	});
}

export async function enableSiteModule(services: ModuleServices, input: Change & { name: string }) {
	const { db, site } = await changeableSite(services, input.orgId, input.siteId);
	const census = rowOf(services, input.name);
	if (census === null) throw refused('That module is not on the list.', 'module_refused');
	if (census.state === 'blocked') {
		throw refused(census.reason ?? 'This module cannot run here.', 'module_refused');
	}
	const params = {
		...baseParams(services, input, site, input.name),
		census: { state: census.state, shipping: census.shipping, reason: census.reason }
	};
	return begin(services, input, {
		type: 'module.enable',
		workflow: 'module-enable',
		plan: planModuleEnable(params),
		params,
		site,
		db
	});
}

// the static refusals come from the guard; the dependents are the site's to report, and the
// engine asks for them before it changes anything
export async function removeSiteModule(services: ModuleServices, input: Change & { name: string }) {
	const { db, site } = await changeableSite(services, input.orgId, input.siteId);
	const census = rowOf(services, input.name);
	const verdict = guardRemoval({
		name: input.name,
		enabledModules: [machineName(input.name)],
		dependents: null,
		census: services.census()
	});
	if (!verdict.ok)
		throw refused(verdict.reason, 'removal_refused', { blockedBy: verdict.blockedBy });
	if (!services.routes.uninstall) throw refused(NEEDS_WORKER_UPDATE, 'needs_worker_update');
	const params = { ...baseParams(services, input, site, input.name), census };
	return begin(services, input, {
		type: 'module.remove',
		workflow: 'module-remove',
		plan: planModuleRemove(params),
		params,
		site,
		db
	});
}

export async function setSiteThemeDefault(
	services: ModuleServices,
	input: Change & { name: string; target: 'default' | 'admin' }
) {
	const { db, site } = await changeableSite(services, input.orgId, input.siteId);
	const census = rowOf(services, input.name);
	if (census === null) throw refused('That theme is not on the list.', 'module_refused');
	if (census.state === 'blocked') {
		throw refused(census.reason ?? 'This theme cannot run here.', 'module_refused');
	}
	if (!services.routes.themeDefault) throw refused(NEEDS_THEME_UPDATE, 'needs_worker_update');
	const params = {
		...baseParams(services, input, site, input.name),
		census: { state: census.state, reason: census.reason },
		target: input.target
	};
	return begin(services, input, {
		type: 'theme.default',
		workflow: 'theme-default',
		plan: planThemeDefault(params),
		params,
		site,
		db
	});
}

// #endregion
