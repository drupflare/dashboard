import type { AuthorityState } from '@contracts/site-auth';
import type { SitePlane } from '@contracts/sites';
import type { UploadMetadata } from '@drupflare/workforce';
import type { ClaimRow, Observation } from '../../src/server/domain/domain-attach';
import type { BackupRecord, ExportPage } from './backup-parts';
import type { BundleLimits, BundleManifest, BundleModule } from './bundle';
import type { Custody, FirstRunAdmin, FirstRunReads, FirstRunSecrets } from './custody';
import type {
	GitPullResult,
	GitRemoteSpec,
	GitSiteRemote,
	PullStatus,
	RemoteRecord
} from './git-parts';
import type { Granted, LeaseRefusal, Refused } from './lease';
import type { OperationStore, SiteRowState } from './operations/store';
import type { ResourceLedger } from './ownership';
import type { ResourceKind } from './provision-plan';
import type { SiteSurvey } from './vendor/drangler/survey';

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
	// the migration tag the live script is at; unset on a first upload
	oldTag?: string;
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
	// secrets and admin are set only when the call names fields to read and the site answered as wanted
	firstRun(
		hostname: string,
		call: SiteCall
	): Promise<{ status: number; secrets?: FirstRunSecrets; admin?: FirstRunAdmin }>;
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
	// files held only in R2, which an export does not carry
	offloadedFiles(hostname: string, auth: OwnerAuth): Promise<number>;
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
	// the managed site this one was adopted into, when it was
	adoptedTo: string | null;
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

// #region cutover

// every call that changes something takes a key built from the operation and the step, so a repeat
// after a restart does nothing more
export interface CutoverSource {
	lowerTtl(
		key: string,
		hostname: string,
		ttlSeconds: number
	): Promise<{ previousTtlSeconds: number }>;
	restoreTtl(key: string, hostname: string, ttlSeconds: number): Promise<void>;
	// a consistent dump and file set, and the marker later deltas count from
	snapshot(key: string): Promise<{ marker: string }>;
	delta(key: string, since: string): Promise<{ marker: string }>;
	applyWritePolicy(key: string, policy: 'freeze' | 'read-only' | 'delta'): Promise<void>;
	restoreWrites(key: string): Promise<void>;
}

export interface CutoverDestination {
	// null when the snapshot plus the delta load and match, otherwise the plain problem
	validate(key: string, snapshot: string, delta: string): Promise<string | null>;
	promote(key: string, snapshot: string, delta: string): Promise<void>;
	// the address that moves, since the destination knows only its own
	route(key: string, to: 'destination' | 'source', hostname: string): Promise<void>;
	acceptedWrites(): Promise<number>;
	observe(): Promise<{ healthy: boolean; writes: number }>;
	// the changes accepted since promote, and what the path back to the source cannot carry
	exportChanges(key: string): Promise<{ reference: string; cannotCarry: string[] }>;
}

export interface CutoverPorts {
	// the organization comes from the signed start, so a ref never reaches another organization's key
	source(ref: string, orgId: string): CutoverSource;
	destination(siteId: string): CutoverDestination;
}

export interface CutoverDeps extends EngineDeps {
	cutover: CutoverPorts;
}

// #endregion

// #region import

export interface SshTarget {
	host: string;
	port: number;
	user: string;
	// PEM, held in memory for one call and never stored
	privateKey: string;
	// the SHA256 fingerprint the owner confirmed; a different host key refuses before any command runs
	expectedFingerprint: string;
	root: string;
}

// read-only survey of a Linux host over SSH; the caller passes the key and the confirmed fingerprint
export interface SshSurvey {
	run(target: SshTarget): Promise<SiteSurvey>;
}

export interface ConvertedChunk {
	// bytes of the input consumed, so the next chunk starts there
	cut: number;
	sql: string;
	rows: number;
	statements: number;
}

export interface SqlConverter {
	convertChunk(bytes: Uint8Array, last: boolean): Promise<ConvertedChunk>;
}

export interface DumpJob {
	kind: 'database' | 'files';
	// every part of a job lives under this prefix and is keyed by its index
	prefix: string;
	partBytes: number;
	// the stream stops with a refusal once it has carried this much
	maxBytes: number;
	// a database job dumps only these tables
	tables?: string[];
	// the structure of these tables and none of their rows; a * stands for any run of characters
	structureOnly?: string[];
}

// streams one read-only command's stdout over a single channel into R2 parts; a repeat clears the
// prefix and writes the same keys again, and nothing is written on the source
export interface DumpStream {
	// onPart runs after each part is written; a throw from it stops the stream
	run(
		target: SshTarget,
		job: DumpJob,
		onPart?: () => Promise<void>
	): Promise<{ parts: number; bytes: number }>;
}

export interface LandTarget {
	siteId: string;
	hostname: string;
	ownerTokenId: string;
}

// the new site's own restore, which carries the database and the files rows in one body
export interface ImportLander {
	// sends the body unless the site already holds an import under this label
	database(site: LandTarget, label: string, body: Uint8Array): Promise<void>;
	state(site: LandTarget, label: string): Promise<ImportState>;
	reason(site: LandTarget, label: string): Promise<string>;
}

// the sealed key of one import, opened only inside a call; a refusal names the credential problem
export interface ImportStore {
	withTarget<T>(
		credentialId: string,
		orgId: string,
		root: string,
		use: (target: SshTarget) => Promise<T>
	): Promise<T>;
	// a repeat is harmless
	discard(credentialId: string): Promise<void>;
	// records the server the site came from and gives the new site its account, which the restore reads
	markImported(
		siteId: string,
		credentialId: string,
		accountId: string,
		now: number
	): Promise<void>;
	// the first start for an operation is kept, so a retried step reports the same clock
	beginRun(operationId: string, orgId: string, at: number): Promise<number>;
	// only the first end counts, so a close after the probe does not move the recorded time
	endRun(operationId: string, at: number): Promise<void>;
}

export interface ImportDeps extends BackupDeps {
	imports: ImportStore;
	survey: SshSurvey;
	dump: DumpStream;
	converter: SqlConverter;
	lander: ImportLander;
}

// #endregion

// #region git

// the site's own /git owner routes; a refusal throws a GitError, and an answer that never came
// throws a retryable error
export interface GitWorker {
	remotes(hostname: string, auth: OwnerAuth): Promise<GitSiteRemote[]>;
	pull(hostname: string, remoteId: string, auth: OwnerAuth): Promise<GitPullResult>;
}

// a pull on a repository the site does not follow yet: the provider token is minted for this one
// call, sent to the site for this one call, and never stored on the site
export interface GitTokenPull {
	pull(
		site: { hostname: string; siteId: string },
		remote: GitRemoteSpec,
		auth: OwnerAuth
	): Promise<GitPullResult>;
}

export interface RemoteLedger {
	get(organizationId: string, siteId: string, id: string): Promise<RemoteRecord | null>;
	record(
		id: string,
		result: { status: PullStatus; at: number; reason: string | null }
	): Promise<void>;
	// the mark a push leaves while a pull runs; a pull clears it when it starts
	clearPending(id: string): Promise<void>;
	// clears the mark and says whether one was set
	takePending(id: string): Promise<boolean>;
}

export interface GitDeps extends BackupDeps {
	git: GitWorker;
	tokenPull: GitTokenPull;
	remotes: RemoteLedger;
}

// #endregion

// #region domains

export interface CustomHostnameState {
	providerId: string;
	observation: Observation;
}

// one hostname of a customer at the certificate provider; a call that cannot be served because the
// account lacks the feature throws a PermanentError that says so
export interface CustomHostnames {
	// finds the hostname at the provider or creates it, so a repeat returns the same one
	ensure(hostname: string): Promise<CustomHostnameState>;
	read(providerId: string): Promise<CustomHostnameState | null>;
	// asks the provider to check again now instead of at its next scheduled time
	refresh(providerId: string): Promise<CustomHostnameState>;
	remove(providerId: string): Promise<'deleted' | 'absent'>;
}

export interface DomainSite {
	organizationId: string;
	accountId: string | null;
	plane: SitePlane;
	state: SiteRowState;
}

export type DomainClaim =
	| {
			ok: true;
			epoch: number;
			providerId: string | null;
			// the claim another site held, when this one took the hostname over
			previous: ClaimRow | null;
	  }
	| { ok: false };

// one row per hostname that is never deleted, so its epoch only rises
export interface DomainLedger {
	site(siteId: string): Promise<DomainSite | null>;
	claim(
		hostname: string,
		who: { organizationId: string; siteId: string; operationId: string },
		now: number
	): Promise<DomainClaim>;
	current(hostname: string): Promise<ClaimRow | null>;
	// each write names the epoch it was made under and does nothing when the hostname has moved on
	setProvider(hostname: string, epoch: number, providerId: string): Promise<boolean>;
	markRouted(hostname: string, epoch: number, siteId: string): Promise<boolean>;
	release(hostname: string, epoch: number, siteId: string): Promise<boolean>;
}

export interface DomainDeps extends EngineDeps {
	hostnames: CustomHostnames;
	domains: DomainLedger;
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
