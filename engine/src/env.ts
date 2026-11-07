import { fromBase64Url, signingKeyFromSeed } from '@contracts/common';
import { dispatch, Resources, SESSION_MARGIN_MS, SESSION_TTL_MS } from '@drupflare/workforce';
import { authorityOf, type SiteAuthStub } from './adapters/authority';
import { D1BackupLedger, r2BackupBlobs } from './adapters/backups';
import { custodyOf } from './adapters/custody';
import { hostsOf } from './adapters/hosts';
import { namespaceKvOf } from './adapters/kv';
import { leasesOf, type LeaseStub } from './adapters/leases';
import { namesOf, type NamesStub } from './adapters/names';
import { releasesOf } from './adapters/releases';
import { backupWorkerOf, siteOf } from './adapters/site';
import { workforceCloudflare } from './adapters/workforce';
import { readConfig } from './config';
import { D1OperationStore } from './operations/store';
import { D1ResourceLedger } from './ownership';
import type { BackupDeps, EngineDeps } from './ports';
import type { BackupCreateInput } from './workflows/backup-create';
import type { BackupRestoreInput } from './workflows/backup-restore';
import type { SiteCreateInput } from './workflows/site-create';
import type { SiteDeleteInput, SitePurgeInput } from './workflows/site-delete';
import type { SiteUpgradeInput } from './workflows/site-upgrade';

export interface EngineEnv {
	DB: D1Database;
	KV: KVNamespace;
	BLOB: R2Bucket;
	HOSTS_KV: KVNamespace;
	SITE_LEASE: DurableObjectNamespace;
	SITE_AUTH: DurableObjectNamespace;
	NAMES: DurableObjectNamespace;
	SITE_CREATE: Workflow<SiteCreateInput>;
	SITE_UPGRADE: Workflow<SiteUpgradeInput>;
	SITE_DELETE: Workflow<SiteDeleteInput>;
	SITE_PURGE: Workflow<SitePurgeInput>;
	BACKUP_CREATE: Workflow<BackupCreateInput>;
	BACKUP_RESTORE: Workflow<BackupRestoreInput>;
	RELEASES_URL: string;
	CF_ACCOUNT_ID: string;
	CF_API_TOKEN: string;
	CONTROL_SEED: string;
	START_SECRET: string;
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
		releases: releasesOf(env.RELEASES_URL, fetch),
		leases: leasesOf((siteId) => stub<LeaseStub>(env.SITE_LEASE, siteId)),
		kv: namespaceKvOf(plane),
		now: Date.now,
		config: readConfig(
			env as unknown as Record<string, unknown>,
			SESSION_TTL_MS - SESSION_MARGIN_MS
		)
	};
}
