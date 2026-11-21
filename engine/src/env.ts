import { fromBase64Url, signingKeyFromSeed } from '@contracts/common';
import { dispatch, Resources, SESSION_MARGIN_MS, SESSION_TTL_MS } from '@drupflare/workforce';
import type { UsageCounter } from '../../dispatch/src/counter';
import { createCollegeDB } from '../../src/server/db/collegedb';
import { DEFAULT_REPAIR_BUDGET } from '../../src/server/domain/incidents';
import { dohResolver } from '../../src/server/integrations/dns-resolver';
import { dohResolve } from '../../src/server/integrations/url-guard';
import { runPreflight } from '../../src/server/services/preflight';
import {
	deriveChallenge,
	loadChallengeKeys,
	type ChallengeKeys
} from '../../src/shared/custody/challenge';
import { CryptoError } from '../../src/shared/custody/envelope';
import { D1AccessLedger } from './adapters/access';
import { authorityOf, type SiteAuthStub } from './adapters/authority';
import { D1BackupLedger, r2BackupBlobs } from './adapters/backups';
import { D1ConfigLedger } from './adapters/config-changes';
import { D1CopyStore } from './adapters/copies';
import { custodyOf } from './adapters/custody';
import { customBundlesOf, type CustomBundlePurge } from './adapters/custom-bundles';
import { cutoverPortsOf } from './adapters/cutover';
import { dohReader } from './adapters/cutover-dns';
import { customHostnamesOf, D1DomainLedger } from './adapters/domains';
import { createDumpStream } from './adapters/dump-stream';
import { estateStoreOf } from './adapters/estate-store';
import { D1RemoteLedger, gitWorkerOf, unavailableTokenPull } from './adapters/git';
import { hostsOf } from './adapters/hosts';
import { createImportLander } from './adapters/import-lander';
import { importStoreOf } from './adapters/import-store';
import { namespaceKvOf } from './adapters/kv';
import { leasesOf, type LeaseStub } from './adapters/leases';
import { D1EditLedger, modifyWorkerOf } from './adapters/modify';
import { moduleWorkerOf } from './adapters/modules';
import { namesOf, type NamesStub } from './adapters/names';
import { D1NodeSites, nodeCommandsOf, type NodeSessionStub } from './adapters/nodes';
import { pitrWorkerOf } from './adapters/pitr';
import { releasesInBucket, releasesOf, releasesWithCustom } from './adapters/releases';
import { D1RepairLedger, repairWorkerOf } from './adapters/repair';
import { rollbackFactsOf } from './adapters/rollback';
import { D1RolloutStore, ringObserverOf, siteMoverOf } from './adapters/rollout';
import {
	connectionTokenOf,
	guardSelfManaged,
	selfManagedDepsOf,
	selfManagedPorts
} from './adapters/self-managed';
import { settingsWorkerOf } from './adapters/settings';
import { backupWorkerOf, siteOf } from './adapters/site';
import { shardDbOf, siteMovesOf } from './adapters/site-moves';
import { createSqlConverter } from './adapters/sql-converter';
import { createSshSurvey } from './adapters/ssh-survey';
import { D1StrataStore } from './adapters/strata';
import { D1TemplateStore, jobRunnerOf } from './adapters/templates';
import { workforceCloudflare } from './adapters/workforce';
import { writeMarkWorkerOf } from './adapters/write-mark';
import { apiBudgetPort, governedFetch, type ApiBudgetStub } from './api-governor';
import { readConfig } from './config';
import { D1NodeStore } from './node-store';
import { D1OperationStore } from './operations/store';
import { D1ResourceLedger } from './ownership';
import type {
	AccessDeps,
	BackupDeps,
	ConfigDeps,
	CopyDeps,
	CutoverDeps,
	DomainDeps,
	EngineDeps,
	EstateDeps,
	GitDeps,
	ImportDeps,
	ModifyDeps,
	ModuleDeps,
	NodeSiteDeps,
	PitrDeps,
	RepairDeps,
	RollbackDeps,
	RolloutDeps,
	TemplateBuildDeps
} from './ports';
import { PermanentError } from './step';
import type { AccessSyncInput } from './workflows/access-sync';
import type { BackupCreateInput } from './workflows/backup-create';
import type { BackupRestoreInput } from './workflows/backup-restore';
import type { ConfigApplyInput } from './workflows/config-apply';
import type { DomainAttachInput } from './workflows/domain-attach';
import type { EnvCreateInput } from './workflows/env-create';
import type { EnvDeleteInput } from './workflows/env-delete';
import type { EstateAssessInput } from './workflows/estate-assess';
import type { GitPullInput } from './workflows/git-pull';
import type { ImportSurveyInput } from './workflows/import-survey';
import type { MigrationCutoverInput } from './workflows/migration-cutover';
import type { ModifyApplyInput } from './workflows/modify-apply';
import type { ModuleEnableInput } from './workflows/module-enable';
import type { ModuleInstallInput } from './workflows/module-install';
import type { ModuleRemoveInput } from './workflows/module-remove';
import type { NodeSiteCreateInput } from './workflows/node-site-create';
import type { ReleaseRingInput } from './workflows/release-ring';
import type { CopyInput } from './workflows/restored-copy';
import type { SiteAdoptInput } from './workflows/site-adopt';
import type { SiteAuthStateInput } from './workflows/site-auth-state';
import type { SiteCleanupInput } from './workflows/site-cleanup';
import type { SiteCreateInput } from './workflows/site-create';
import type { SiteDeleteInput, SitePurgeInput } from './workflows/site-delete';
import type { SiteImportInput } from './workflows/site-import';
import type { SitePitrInput } from './workflows/site-pitr';
import type { SiteRepairInput } from './workflows/site-repair';
import type { SiteRollbackInput } from './workflows/site-rollback';
import type { SiteTransferInput, TransferDeps } from './workflows/site-transfer';
import type { SiteUpgradeInput } from './workflows/site-upgrade';
import type { TemplateBuildInput } from './workflows/template-build';
import type { ThemeDefaultInput } from './workflows/theme-default';

export interface EngineEnv {
	DB: D1Database;
	KV: KVNamespace;
	BLOB: R2Bucket;
	HOSTS_KV: KVNamespace;
	SITE_LEASE: DurableObjectNamespace;
	SITE_AUTH: DurableObjectNamespace;
	NAMES: DurableObjectNamespace;
	NODE_SESSION: DurableObjectNamespace;
	API_BUDGET: DurableObjectNamespace;
	USAGE_COUNTER: DurableObjectNamespace<UsageCounter>;
	SITE_CREATE: Workflow<SiteCreateInput>;
	SITE_UPGRADE: Workflow<SiteUpgradeInput>;
	SITE_DELETE: Workflow<SiteDeleteInput>;
	SITE_PURGE: Workflow<SitePurgeInput>;
	SITE_CLEANUP: Workflow<SiteCleanupInput>;
	SITE_AUTH_STATE: Workflow<SiteAuthStateInput>;
	SITE_ADOPT: Workflow<SiteAdoptInput>;
	SITE_REPAIR: Workflow<SiteRepairInput>;
	SITE_ROLLBACK: Workflow<SiteRollbackInput>;
	RELEASE_RING: Workflow<ReleaseRingInput>;
	BACKUP_CREATE: Workflow<BackupCreateInput>;
	BACKUP_RESTORE: Workflow<BackupRestoreInput>;
	BACKUP_VERIFY: Workflow<CopyInput>;
	ACCESS_SYNC: Workflow<AccessSyncInput>;
	ENV_CREATE: Workflow<EnvCreateInput>;
	ENV_DELETE: Workflow<EnvDeleteInput>;
	SITE_PITR: Workflow<SitePitrInput>;
	CONFIG_APPLY: Workflow<ConfigApplyInput>;
	MODULE_INSTALL: Workflow<ModuleInstallInput>;
	MODULE_ENABLE: Workflow<ModuleEnableInput>;
	MODIFY_APPLY: Workflow<ModifyApplyInput>;
	MODULE_REMOVE: Workflow<ModuleRemoveInput>;
	THEME_DEFAULT: Workflow<ThemeDefaultInput>;
	MIGRATION_CUTOVER: Workflow<MigrationCutoverInput>;
	SITE_IMPORT: Workflow<SiteImportInput>;
	IMPORT_SURVEY: Workflow<ImportSurveyInput>;
	ESTATE_ASSESS: Workflow<EstateAssessInput>;
	GIT_PULL: Workflow<GitPullInput>;
	DOMAIN_ATTACH: Workflow<DomainAttachInput>;
	NODE_SITE_CREATE: Workflow<NodeSiteCreateInput>;
	TEMPLATE_BUILD: Workflow<TemplateBuildInput>;
	SITE_TRANSFER: Workflow<SiteTransferInput>;
	// bound on the stage deployment only; without it a template build records that it cannot run
	JOB_RUNNER?: DurableObjectNamespace;
	RELEASES_URL: string;
	// 'blob' reads releases from the BLOB bucket and ignores RELEASES_URL
	RELEASES_STORE?: string;
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
	// the zone that holds customers' custom hostnames and the name they point at; unset turns custom domains off
	CUSTOM_HOSTNAME_ZONE_ID?: string;
	CUSTOM_HOSTNAME_TARGET?: string;
	CONTROL_SEED: string;
	START_SECRET: string;
	// the dashboard signs budget writes and counts reads with these, one secret per message type;
	// an unset one falls back to START_SECRET
	BUDGET_SECRET?: string;
	COUNTS_SECRET?: string;
	// '1' in the stage environment only: the cron applies the count writes queued under `prime:` in KV
	PRIME_MODE?: string;
	FLEET_SEED: string;
	DISPATCH_NAMESPACE: string;
	LEASE_TTL_MS: string | number;
	ASSET_CHUNK_BYTES: string | number;
	LIMIT_MODULE_BYTES: string | number;
	LIMIT_TOTAL_BYTES: string | number;
	LIMIT_ASSET_BYTES: string | number;
	LIMIT_ASSETS: string | number;
	SITE_TIMEOUT_MS: string | number;
	PENDING_SECRET_TTL_MS: string | number;
	// the key-encryption-key secrets, one per version, the same values the dashboard holds
	[kek: `KEK_V${number}`]: string | undefined;
}

function stub<T>(namespace: DurableObjectNamespace, name: string): T {
	return namespace.get(namespace.idFromName(name)) as unknown as T;
}

export async function buildBackupDeps(env: EngineEnv): Promise<BackupDeps> {
	const plane = dispatch({
		accountId: env.CF_ACCOUNT_ID,
		token: env.CF_API_TOKEN,
		namespace: env.DISPATCH_NAMESPACE
	});
	return {
		...(await buildDeps(env)),
		worker: backupWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS)),
		blobs: r2BackupBlobs(env.BLOB),
		backups: new D1BackupLedger(env.DB),
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
	};
}

export async function buildModuleDeps(env: EngineEnv): Promise<ModuleDeps> {
	return {
		...(await buildBackupDeps(env)),
		modules: moduleWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS)),
		strata: new D1StrataStore(env.DB)
	};
}

export async function buildModifyDeps(env: EngineEnv): Promise<ModifyDeps> {
	return {
		...(await buildBackupDeps(env)),
		modify: modifyWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS)),
		edits: new D1EditLedger(env.DB)
	};
}

export async function buildAccessDeps(env: EngineEnv): Promise<AccessDeps> {
	return { ...(await buildDeps(env)), access: new D1AccessLedger(env.DB) };
}

export async function buildCopyDeps(env: EngineEnv): Promise<CopyDeps> {
	const copies = new D1CopyStore(env.DB);
	return {
		...(await buildBackupDeps(env)),
		environments: copies,
		verifications: copies,
		access: new D1AccessLedger(env.DB)
	};
}

export async function buildPitrDeps(env: EngineEnv): Promise<PitrDeps> {
	return {
		...(await buildBackupDeps(env)),
		pitr: pitrWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS))
	};
}

export async function buildConfigDeps(env: EngineEnv): Promise<ConfigDeps> {
	return {
		...(await buildBackupDeps(env)),
		settings: settingsWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS)),
		changes: new D1ConfigLedger(env.DB)
	};
}

// the rows of two organisations may sit in two databases, so the move goes through the same shard
// router the dashboard uses; this needs KV to be the dashboard's namespace and every DB_n bound
export async function buildTransferDeps(env: EngineEnv): Promise<TransferDeps> {
	return {
		...(await buildDeps(env)),
		moves: siteMovesOf(shardDbOf(createCollegeDB(env as never)))
	};
}

export function buildTemplateBuildDeps(env: EngineEnv): TemplateBuildDeps {
	return {
		jobs: env.JOB_RUNNER
			? jobRunnerOf(env.JOB_RUNNER as never)
			: {
					run: async () => {
						throw new PermanentError(
							'runner_unbound',
							'no job runner is bound on this deployment'
						);
					}
				},
		blobs: r2BackupBlobs(env.BLOB),
		templates: new D1TemplateStore(env.DB)
	};
}

export async function buildRepairDeps(env: EngineEnv): Promise<RepairDeps> {
	return {
		...(await buildBackupDeps(env)),
		repair: repairWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS)),
		repairs: new D1RepairLedger(env.DB),
		ringPromotion: (siteId) => new D1RolloutStore(env.DB).inRollingRollout(siteId),
		budget: DEFAULT_REPAIR_BUDGET
	};
}

export async function buildRollbackDeps(env: EngineEnv): Promise<RollbackDeps> {
	return { ...(await buildDeps(env)), rollbackFacts: rollbackFactsOf(env.DB) };
}

export async function buildRolloutDeps(env: EngineEnv): Promise<RolloutDeps> {
	const base = await buildRepairDeps(env);
	return {
		...base,
		mover: siteMoverOf({
			db: env.DB,
			store: base.store,
			upgrade: env.SITE_UPGRADE,
			rollback: env.SITE_ROLLBACK,
			now: Date.now
		}),
		rollouts: new D1RolloutStore(env.DB),
		observe: ringObserverOf({
			backups: base.backups,
			custody: base.custody,
			repair: base.repair,
			site: base.site
		})
	};
}

// the connection library loads here and not at the top, so only an import pays for it
export async function buildImportDeps(env: EngineEnv): Promise<ImportDeps> {
	const base = await buildBackupDeps(env);
	const { edgeportConnector, edgeportStreamConnector } = await import('./adapters/edgeport-ssh');
	return {
		...base,
		imports: importStoreOf({
			db: env.DB,
			secrets: env as unknown as Record<string, string | undefined>,
			now: Date.now
		}),
		survey: createSshSurvey(edgeportConnector),
		dump: createDumpStream(edgeportStreamConnector, base.blobs),
		converter: createSqlConverter(),
		lander: createImportLander({ custody: base.custody, worker: base.worker })
	};
}

export async function buildEstateDeps(env: EngineEnv): Promise<EstateDeps> {
	return {
		...(await buildImportDeps(env)),
		estate: estateStoreOf(env.DB),
		preflight: (hostname) =>
			runPreflight(
				{
					fetch: (input, init) => fetch(input, init),
					resolve: (name) => dohResolve(name),
					now: Date.now,
					contactUrl: 'https://app.drupflare.com/migrate/preflight'
				},
				hostname
			)
	};
}

export async function buildGitDeps(env: EngineEnv): Promise<GitDeps> {
	return {
		...(await buildBackupDeps(env)),
		git: gitWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS)),
		tokenPull: unavailableTokenPull,
		remotes: new D1RemoteLedger(env.DB)
	};
}

export async function buildDomainDeps(
	env: EngineEnv
): Promise<DomainDeps & { customBundles: CustomBundlePurge }> {
	let keys: Promise<ChallengeKeys> | undefined;
	const target = env.CUSTOM_HOSTNAME_TARGET;
	return {
		...(await buildDeps(env)),
		customBundles: customBundlesOf(env.DB, r2BackupBlobs(env.BLOB)),
		dns: dohResolver(fetch),
		target: target === undefined || target === '' ? null : target,
		// the key ring loads on first use, so a delete never pays for it
		challenge: async (input) => {
			keys ??= loadChallengeKeys(env as unknown as Record<string, string | undefined>);
			try {
				return deriveChallenge(await keys, input);
			} catch (error) {
				keys = undefined;
				if (error instanceof CryptoError) {
					throw new PermanentError('domain_checks_unavailable', error.message);
				}
				throw error;
			}
		},
		hostnames: customHostnamesOf({
			fetch,
			token: env.CF_API_TOKEN,
			zoneId: env.CUSTOM_HOSTNAME_ZONE_ID,
			target: env.CUSTOM_HOSTNAME_TARGET,
			timeoutMs: Number(env.SITE_TIMEOUT_MS)
		}),
		domains: new D1DomainLedger(env.DB, Date.now)
	};
}

export async function buildNodeSiteDeps(env: EngineEnv): Promise<NodeSiteDeps> {
	return {
		...(await buildDeps(env)),
		nodes: nodeCommandsOf(
			(nodeId) => stub<NodeSessionStub>(env.NODE_SESSION, nodeId),
			new D1NodeStore(env.DB)
		),
		sites: new D1NodeSites(env.DB),
		domains: new D1DomainLedger(env.DB, Date.now)
	};
}

export async function buildCutoverDeps(env: EngineEnv): Promise<CutoverDeps> {
	const base = await buildImportDeps(env);
	const { edgeportConnector } = await import('./adapters/edgeport-ssh');
	return {
		...base,
		cutover: cutoverPortsOf({
			imports: base.imports,
			connector: edgeportConnector,
			dump: base.dump,
			converter: base.converter,
			blobs: base.blobs,
			dns: dohReader(),
			backups: base.backups,
			custody: base.custody,
			worker: base.worker,
			marks: writeMarkWorkerOf(fetch, Number(env.SITE_TIMEOUT_MS)),
			site: base.site,
			sleep: base.sleep,
			now: base.now
		})
	};
}

export async function buildDeps(env: EngineEnv): Promise<EngineDeps> {
	const budget = stub<ApiBudgetStub>(env.API_BUDGET, env.CF_ACCOUNT_ID);
	const plane = dispatch({
		accountId: env.CF_ACCOUNT_ID,
		token: env.CF_API_TOKEN,
		namespace: env.DISPATCH_NAMESPACE,
		fetch: governedFetch((input, init) => fetch(input, init), apiBudgetPort(budget), {
			retryOnce: false
		})
	});
	const { privateKey } = await signingKeyFromSeed(fromBase64Url(env.CONTROL_SEED));
	return {
		store: new D1OperationStore(env.DB),
		ledger: new D1ResourceLedger(env.DB),
		cloudflare: workforceCloudflare(
			plane,
			new Resources(plane.http, env.CF_ACCOUNT_ID),
			env.CF_API_TOKEN
		),
		authority: authorityOf({
			siteAuth: (siteId) => stub<SiteAuthStub>(env.SITE_AUTH, siteId),
			hosts: hostsOf(env.HOSTS_KV),
			controlKey: privateKey,
			now: Date.now
		}),
		names: namesOf((shard) => stub<NamesStub>(env.NAMES, shard)),
		site: siteOf(fetch, Number(env.SITE_TIMEOUT_MS)),
		custody: custodyOf({
			db: env.DB,
			secrets: env as unknown as Record<string, string | undefined>,
			pendingTtlMs: Number(env.PENDING_SECRET_TTL_MS),
			now: Date.now
		}),
		releases: releasesWithCustom(
			env.RELEASES_STORE === 'blob'
				? releasesInBucket(env.BLOB)
				: releasesOf(env.RELEASES_URL, fetch),
			releasesInBucket(env.BLOB)
		),
		leases: leasesOf((siteId) => stub<LeaseStub>(env.SITE_LEASE, siteId)),
		kv: namespaceKvOf(plane),
		now: Date.now,
		config: readConfig(
			env as unknown as Record<string, unknown>,
			SESSION_TTL_MS - SESSION_MARGIN_MS
		)
	};
}

// the same deps with the customer's account in place of ours; nothing here holds the token, since
// each call opens it again
export function selfManagedDeps<D extends EngineDeps>(
	env: EngineEnv,
	deps: D,
	scope: { siteId: string; accountId: string }
): D {
	const ports = selfManagedPorts({
		accountId: scope.accountId,
		open: connectionTokenOf({
			db: env.DB,
			secrets: env as unknown as Record<string, string | undefined>,
			...scope
		})
	});
	return selfManagedDepsOf(deps, guardSelfManaged(ports, { ...scope, ledger: deps.ledger }));
}
