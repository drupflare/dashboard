import { fromBase64Url, signingKeyFromSeed } from '@contracts/common';
import { dispatch, Resources, SESSION_MARGIN_MS, SESSION_TTL_MS } from '@drupflare/workforce';
import { dohResolver } from '../../src/server/integrations/dns-resolver';
import { dohResolve } from '../../src/server/integrations/url-guard';
import { runPreflight } from '../../src/server/services/preflight';
import {
	deriveChallenge,
	loadChallengeKeys,
	type ChallengeKeys
} from '../../src/shared/custody/challenge';
import { CryptoError } from '../../src/shared/custody/envelope';
import { authorityOf, type SiteAuthStub } from './adapters/authority';
import { D1BackupLedger, r2BackupBlobs } from './adapters/backups';
import { custodyOf } from './adapters/custody';
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
import { namesOf, type NamesStub } from './adapters/names';
import { D1NodeSites, nodeCommandsOf, type NodeSessionStub } from './adapters/nodes';
import { releasesInBucket, releasesOf } from './adapters/releases';
import { backupWorkerOf, siteOf } from './adapters/site';
import { createSqlConverter } from './adapters/sql-converter';
import { createSshSurvey } from './adapters/ssh-survey';
import { workforceCloudflare } from './adapters/workforce';
import { writeMarkWorkerOf } from './adapters/write-mark';
import { readConfig } from './config';
import { D1NodeStore } from './node-store';
import { D1OperationStore } from './operations/store';
import { D1ResourceLedger } from './ownership';
import type {
	BackupDeps,
	CutoverDeps,
	DomainDeps,
	EngineDeps,
	EstateDeps,
	GitDeps,
	ImportDeps,
	NodeSiteDeps
} from './ports';
import { PermanentError } from './step';
import type { BackupCreateInput } from './workflows/backup-create';
import type { BackupRestoreInput } from './workflows/backup-restore';
import type { DomainAttachInput } from './workflows/domain-attach';
import type { EstateAssessInput } from './workflows/estate-assess';
import type { GitPullInput } from './workflows/git-pull';
import type { ImportSurveyInput } from './workflows/import-survey';
import type { MigrationCutoverInput } from './workflows/migration-cutover';
import type { NodeSiteCreateInput } from './workflows/node-site-create';
import type { SiteAdoptInput } from './workflows/site-adopt';
import type { SiteCleanupInput } from './workflows/site-cleanup';
import type { SiteCreateInput } from './workflows/site-create';
import type { SiteDeleteInput, SitePurgeInput } from './workflows/site-delete';
import type { SiteImportInput } from './workflows/site-import';
import type { SiteUpgradeInput } from './workflows/site-upgrade';

export interface EngineEnv {
	DB: D1Database;
	KV: KVNamespace;
	BLOB: R2Bucket;
	HOSTS_KV: KVNamespace;
	SITE_LEASE: DurableObjectNamespace;
	SITE_AUTH: DurableObjectNamespace;
	NAMES: DurableObjectNamespace;
	NODE_SESSION: DurableObjectNamespace;
	SITE_CREATE: Workflow<SiteCreateInput>;
	SITE_UPGRADE: Workflow<SiteUpgradeInput>;
	SITE_DELETE: Workflow<SiteDeleteInput>;
	SITE_PURGE: Workflow<SitePurgeInput>;
	SITE_CLEANUP: Workflow<SiteCleanupInput>;
	SITE_ADOPT: Workflow<SiteAdoptInput>;
	BACKUP_CREATE: Workflow<BackupCreateInput>;
	BACKUP_RESTORE: Workflow<BackupRestoreInput>;
	MIGRATION_CUTOVER: Workflow<MigrationCutoverInput>;
	SITE_IMPORT: Workflow<SiteImportInput>;
	IMPORT_SURVEY: Workflow<ImportSurveyInput>;
	ESTATE_ASSESS: Workflow<EstateAssessInput>;
	GIT_PULL: Workflow<GitPullInput>;
	DOMAIN_ATTACH: Workflow<DomainAttachInput>;
	NODE_SITE_CREATE: Workflow<NodeSiteCreateInput>;
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

export async function buildDomainDeps(env: EngineEnv): Promise<DomainDeps> {
	let keys: Promise<ChallengeKeys> | undefined;
	const target = env.CUSTOM_HOSTNAME_TARGET;
	return {
		...(await buildDeps(env)),
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
	const plane = dispatch({
		accountId: env.CF_ACCOUNT_ID,
		token: env.CF_API_TOKEN,
		namespace: env.DISPATCH_NAMESPACE
	});
	const { privateKey } = await signingKeyFromSeed(fromBase64Url(env.CONTROL_SEED));
	return {
		store: new D1OperationStore(env.DB),
		ledger: new D1ResourceLedger(env.DB),
		cloudflare: workforceCloudflare(plane, new Resources(plane.http, env.CF_ACCOUNT_ID)),
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
		releases:
			env.RELEASES_STORE === 'blob'
				? releasesInBucket(env.BLOB)
				: releasesOf(env.RELEASES_URL, fetch),
		leases: leasesOf((siteId) => stub<LeaseStub>(env.SITE_LEASE, siteId)),
		kv: namespaceKvOf(plane),
		now: Date.now,
		config: readConfig(
			env as unknown as Record<string, unknown>,
			SESSION_TTL_MS - SESSION_MARGIN_MS
		)
	};
}
