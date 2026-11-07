import type { AuthorityState } from '@contracts/site-auth';
import type { SitePlane } from '@contracts/sites';
import type { UploadMetadata } from '@drupflare/workforce';
import type { BackupRecord, ExportPage } from './backup-parts';
import type { BundleLimits, BundleManifest, BundleModule } from './bundle';
import type { Custody, FirstRunReads, FirstRunSecrets } from './custody';
import type { Granted, LeaseRefusal, Refused } from './lease';
import type { OperationStore, SiteRowState } from './operations/store';
import type { ResourceLedger } from './ownership';
import type { ResourceKind } from './provision-plan';

// #region cloudflare

export interface ProviderResource {
	providerId: string;
}

export interface AssetSession {
	jwt: string;
	buckets: string[][];
	complete: boolean;
}

export interface ScriptUpload {
	main: string;
	metadata: Omit<UploadMetadata, 'main_module'>;
	modules: { module: BundleModule; bytes: Uint8Array }[];
}

export interface ListedResource {
	id: string;
	name: string;
}

export interface ScriptInfo {
	tags: string[];
	version: string | null;
}

export interface AccountRoute {
	id: string;
	zoneId: string;
	pattern: string;
	script: string | null;
}

export interface RateHeadroom {
	remaining: number | null;
	resetSeconds: number | null;
	quota: number | null;
	windowSeconds: number | null;
}

export interface CloudflareUsage {
	kvNamespaces: number;
	buckets: number;
	rate: RateHeadroom;
}

// one account; every delete says whether it removed anything so a repeat is harmless.
// the list, get and read methods never change anything; the rest are called only through
// the guards in ownership.ts
export interface Cloudflare {
	listResources(kind: ResourceKind): Promise<ListedResource[]>;
	getScript(name: string): Promise<ScriptInfo | null>;
	listRoutes(zoneId: string): Promise<AccountRoute[]>;
	readUsage(): Promise<CloudflareUsage>;
	findResource(kind: ResourceKind, name: string): Promise<ProviderResource | null>;
	createResource(kind: ResourceKind, name: string): Promise<ProviderResource>;
	deleteResource(kind: ResourceKind, providerId: string): Promise<'deleted' | 'absent'>;
	addRoute(zoneId: string, pattern: string, script: string): Promise<ProviderResource>;
	removeRoute(zoneId: string, routeId: string): Promise<'deleted' | 'absent'>;
	putScript(name: string, upload: ScriptUpload): Promise<{ versionId: string | null }>;
	deleteScript(name: string): Promise<'deleted' | 'absent'>;
	startAssetSession(
		script: string,
		manifest: Record<string, { hash: string; size: number }>
	): Promise<AssetSession>;
	uploadAssetBucket(jwt: string, files: { hash: string; bytes: Uint8Array }[]): Promise<string>;
}

// #endregion

// #region authority and names

export interface HostRoute {
	siteId: string;
	script: string;
	epoch: number;
}

export interface Authority {
	read(siteId: string): Promise<AuthorityState | null>;
	apply(state: AuthorityState): Promise<{ applied: boolean; generation: number }>;
	putHost(host: string, route: HostRoute): Promise<void>;
	// removes the route only when it names this site; another site's route is left as it is
	deleteHostIfOwned(host: string, siteId: string): Promise<'deleted' | 'absent' | 'foreign'>;
}

export type ReserveAnswer = 'reserved' | 'held' | 'taken' | 'reserved-word' | 'invalid';
export type ReleaseAnswer = 'released' | 'tombstoned' | 'not-owner' | 'unknown';

export interface Names {
	reserve(name: string, siteId: string): Promise<ReserveAnswer>;
	confirm(name: string, siteId: string): Promise<boolean>;
	release(name: string, siteId: string, holdMs?: number): Promise<ReleaseAnswer>;
}

// #endregion

// #region the site and the release store

export interface SiteCall {
	method: 'GET' | 'POST';
	path: string;
	body?: string;
	expectStatus?: number;
	reads?: FirstRunReads;
}

export interface Site {
	probe(
		hostname: string,
		path: string,
		expectStatus?: number,
		auth?: { bearer: string }
	): Promise<{ status: number }>;
	// secrets are set only when the call names fields to read and the site answered as wanted
	firstRun(
		hostname: string,
		call: SiteCall
	): Promise<{ status: number; secrets?: FirstRunSecrets }>;
	// posts a nonce whose hash record the caller has already written to the site's CONFIG_KV; the
	// token is set only when the site answered 200
	recoverOwnerToken(
		hostname: string,
		nonce: string
	): Promise<{ status: number; ownerToken: string | null }>;
}

export interface Releases {
	manifest(releaseId: string): Promise<unknown>;
	part(key: string): Promise<Uint8Array>;
}

// #endregion

// #region leases

export interface Leases {
	acquire(
		siteId: string,
		request: { holder: string; purpose: string; ttlMs: number }
	): Promise<Granted | Refused>;
	heartbeat(
		siteId: string,
		request: { holder: string; epoch: number; ttlMs: number }
	): Promise<Granted | Refused>;
	release(
		siteId: string,
		request: { holder: string; epoch: number }
	): Promise<{ ok: true } | Refused>;
	check(siteId: string, request: { holder: string; epoch: number }): Promise<Granted | Refused>;
}

export type { LeaseRefusal };

// #endregion

// #region backups

export interface OwnerAuth {
	bearer: string;
}

export type ImportState = 'absent' | 'pending' | 'applied' | 'failed';

// the worker's owner routes; every call takes the owner token the caller opened from custody
export interface BackupWorker {
	exportPage(hostname: string, cursor: string, auth: OwnerAuth): Promise<ExportPage>;
	restore(
		hostname: string,
		body: Uint8Array,
		label: string,
		auth: OwnerAuth
	): Promise<{ chunks: number; statements: number }>;
	importState(hostname: string, label: string, auth: OwnerAuth): Promise<ImportState>;
	// where an import stopped and the site's reason, empty when it carries none
	importReason(hostname: string, label: string, auth: OwnerAuth): Promise<string>;
	adopting(hostname: string, auth: OwnerAuth): Promise<number>;
}

export interface BackupBlobs {
	put(key: string, bytes: Uint8Array): Promise<void>;
	get(key: string): Promise<Uint8Array | null>;
	deletePrefix(prefix: string): Promise<number>;
}

export interface BackupSite {
	id: string;
	organizationId: string;
	accountId: string | null;
	plane: SitePlane;
	state: SiteRowState;
	primaryHostname: string | null;
}

export interface BackupLedger {
	site(siteId: string): Promise<BackupSite | null>;
	// the row of an operation that already recorded one is returned unchanged
	record(row: BackupRecord): Promise<BackupRecord>;
	get(organizationId: string, id: string): Promise<BackupRecord | null>;
}

// one KV namespace of the account; callers reach it only through the ownership guard
export interface NamespaceKv {
	put(namespaceId: string, key: string, value: string): Promise<void>;
	delete(namespaceId: string, key: string): Promise<'deleted' | 'absent'>;
}

export interface BackupDeps extends EngineDeps {
	worker: BackupWorker;
	blobs: BackupBlobs;
	backups: BackupLedger;
	sleep(ms: number): Promise<void>;
}

// #endregion

export interface EngineConfig {
	leaseTtlMs: number;
	chunkBytes: number;
	assetSessionMs: number;
	limits: BundleLimits;
	account?: { kvNamespaces: number; buckets?: number };
}

export interface EngineDeps {
	store: OperationStore;
	ledger: ResourceLedger;
	cloudflare: Cloudflare;
	authority: Authority;
	names: Names;
	site: Site;
	custody: Custody;
	releases: Releases;
	leases: Leases;
	kv: NamespaceKv;
	now(): number;
	config: EngineConfig;
}

export type { BundleManifest };
