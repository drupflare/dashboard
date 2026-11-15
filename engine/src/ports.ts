import type { EstateReport, RowVerdict } from '@contracts/estate';
import type { AuthorityState } from '@contracts/site-auth';
import type { SitePlane } from '@contracts/sites';
import type { Ring } from '../../src/server/domain/cohorts';
import type { DnsResolver } from '../../src/server/domain/dns-check';
import type { ClaimRow, Observation } from '../../src/server/domain/domain-attach';
import type { CommandRequest } from '../../src/server/domain/fleet';
import type { RepairBudget } from '../../src/server/domain/incidents';
import type { RingObservation, RolloutState } from '../../src/server/domain/rings';
import type { AccessRule } from '../../src/shared/access-presets';
import type { Challenge, ChallengeInput } from '../../src/shared/custody/challenge';
import type { EstateRowRecord } from '../../src/shared/estate-sql';
import type { Observation as HealthObservation } from '../../src/shared/health/predicate';
import type { PreflightResult } from '../../src/shared/preflight';
import type { SettingsResponse } from '../../src/shared/site-config/levers';
import type { BackupRecord, ExportPage } from './backup-parts';
import type { BundleLimits, BundleManifest, BundleModule } from './bundle';
import type { RunRecord, RunRefusal } from './containers/jobs';
import type { Custody, FirstRunAdmin, FirstRunReads, FirstRunSecrets } from './custody';
import type { DescriptorMetadata } from './descriptor';
import type {
	GitPullResult,
	GitRemoteSpec,
	GitSiteRemote,
	PullStatus,
	RemoteRecord
} from './git-parts';
import type { Granted, LeaseRefusal, Refused } from './lease';
import type { CommandStatus, SendResult } from './node-link';
import type { OperationStore, SiteRowState } from './operations/store';
import type { ResourceLedger } from './ownership';
import type { ResourceKind } from './provision-plan';
import type { LadderSwitches, RepairRecord, RepairStatus } from './repair/rows';
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
	metadata: Omit<DescriptorMetadata, 'main_module'>;
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
	// read on a customer's account only
	scripts?: number;
	// false when the account has no object storage turned on
	r2Enabled?: boolean;
}

// a customer's account only: the workers.dev address of its sites
export interface AccountHosts {
	// the account's workers.dev subdomain; null when it has none
	subdomain(): Promise<string | null>;
	enableWorkersDev(script: string): Promise<void>;
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
	// a token that reads and writes one bucket and nothing else; the secret cannot be read again,
	// so the caller holds it for one call and never stores it
	mintBucketToken(bucket: string, name: string): Promise<BucketToken>;
	// deletes every token with this name and says how many went; none is not an error
	deleteBucketTokens(name: string): Promise<number>;
}

// the S3 credentials of a bucket token: the key id is the token id, the secret is the SHA-256 of its value
export interface BucketToken {
	tokenId: string;
	accessKeyId: string;
	secretAccessKey: string;
}

// #endregion

// #region authority and names

export interface HostRoute {
	siteId: string;
	script: string;
	epoch: number;
	// the environment this host serves; a host with none is production
	environment?: string;
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
		auth: OwnerAuth,
		// a mark id the site opens in the turn that applies the last chunk; echoed when it will
		mark?: string
	): Promise<{ chunks: number; statements: number; mark?: string }>;
	importState(hostname: string, label: string, auth: OwnerAuth): Promise<ImportState>;
	// where an import stopped and the site's reason, empty when it carries none
	importReason(hostname: string, label: string, auth: OwnerAuth): Promise<string>;
	adopting(hostname: string, auth: OwnerAuth): Promise<number>;
	// files held only in R2, which an export does not carry
	offloadedFiles(hostname: string, auth: OwnerAuth): Promise<number>;
	// one window of a composer lock installed on the site, from the cursor the last window reached;
	// 'absent' when the site has no such route
	installLock(
		hostname: string,
		lock: Uint8Array,
		cursor: number,
		auth: OwnerAuth
	): Promise<InstallLockWindow | 'absent'>;
	// removes what a failed lock session wrote; a session the site no longer holds is already gone
	rollbackLock(hostname: string, session: string, auth: OwnerAuth): Promise<void>;

	// #region the paged restore: whether the site has the routes, then one call per step of the upload
	pagedRestoreSupported(hostname: string, auth: OwnerAuth): Promise<boolean>;
	beginRestore(
		hostname: string,
		declaration: RestoreDeclaration,
		auth: OwnerAuth
	): Promise<RestoreUpload>;
	putRestorePart(
		hostname: string,
		upload: string,
		part: number,
		bytes: Uint8Array,
		sha256: string,
		auth: OwnerAuth
	): Promise<void>;
	// null when the site holds no such upload
	restoreStatus(hostname: string, upload: string, auth: OwnerAuth): Promise<RestoreUpload | null>;
	commitRestore(
		hostname: string,
		upload: string,
		auth: OwnerAuth
	): Promise<{ done: boolean; assembledParts: number; gone: boolean }>;
	abortRestore(hostname: string, upload: string, auth: OwnerAuth): Promise<void>;
	// #endregion

	// #region files held only in R2; null when the site has no such route
	offloadedPage(
		hostname: string,
		after: string | null,
		limit: number,
		auth: OwnerAuth
	): Promise<OffloadedPage | null>;
	offloadedStream(hostname: string, uri: string, auth: OwnerAuth): Promise<OffloadedStream>;
	// #endregion
}

export interface InstallLockWindow {
	done: boolean;
	// the package index the next window starts from
	cursor: number;
	total: number;
	installed: number;
	skipped: number;
	// the first package the site could not install, with its reason; null when none failed
	failure: { name: string; error: string } | null;
	// the site's id for this lock session, the handle a rollback names
	session: string;
	// every package the session skipped so far, with the site's reason for each
	skippedPackages: { name: string; reason: string }[];
	// the site's word for Composer patches, 'not applied' because a lock carries none
	patches: string;
}

export interface RestoreDeclaration {
	bytes: number;
	parts: number;
	// hex digest of the whole dump, the parts joined in order
	sha256: string;
	label: string;
}

export interface RestoreUpload {
	upload: string;
	// the part numbers the site already holds
	receivedParts: number[];
}

export interface OffloadedFile {
	uri: string;
	size: number;
	contentType: string | null;
	// hex digest the site recorded, when it recorded one
	sha256: string | null;
	modified: number;
}

export interface OffloadedPage {
	files: OffloadedFile[];
	// the uri to pass as after for the next page, null on the last
	next: string | null;
	// on the first page only
	total: { files: number; bytes: number } | null;
}

// the body is read once, as it arrives, and never held whole
export interface OffloadedStream {
	body: ReadableStream<Uint8Array>;
	size: number;
	sha256: string | null;
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

// #region restored copies, environments and point-in-time recovery

// the status vocabulary is src/shared/environments.ts; an unknown one is refused
export interface EnvironmentStore {
	setStatus(organizationId: string, id: string, status: string, now: number): Promise<void>;
}

export interface VerificationStore {
	// a backup that is not in the organisation stays as it is
	markVerified(organizationId: string, backupId: string, now: number): Promise<void>;
}

// the live access rules of one site and the sites its environments run as; a revoked rule and a
// deleted environment are never returned
export interface AccessLedger {
	load(
		organizationId: string,
		siteId: string
	): Promise<{
		rules: AccessRule[];
		environments: { id: string; siteId: string | null }[];
	}>;
	// the production site an environment belongs to, null when the organisation has no such environment
	parentOf(organizationId: string, environmentId: string): Promise<string | null>;
}

export interface AccessDeps extends EngineDeps {
	access: AccessLedger;
}

export interface CopyDeps extends BackupDeps {
	environments: EnvironmentStore;
	verifications: VerificationStore;
	access: AccessLedger;
}

export interface PitrScheduled {
	scheduled: string;
	// the bookmark that reverses the restore, returned only by the call that schedules it
	undo: string;
}

// the site's owner route for point-in-time recovery; a refused token throws, a back end with no
// change log throws a permanent error
export interface PitrWorker {
	bookmarkAt(hostname: string, at: number, auth: OwnerAuth): Promise<string>;
	schedule(hostname: string, bookmark: string, auth: OwnerAuth): Promise<PitrScheduled>;
}

export interface PitrDeps extends BackupDeps {
	pitr: PitrWorker;
}

// #endregion

// #endregion

// #region site settings

export type SettingLever = SettingsResponse['levers'][number];

export interface SettingsPatchAnswer {
	refused: string[];
	invalid: { name: string; reason: string }[];
}

// the site's owner route for runtime settings; a refused token or a changed etag throws a permanent error
export interface SettingsWorker {
	read(hostname: string, auth: OwnerAuth): Promise<SettingLever[]>;
	// a null value clears the override; ifMatch is sent as If-Match when the caller holds an etag
	write(
		hostname: string,
		patch: Record<string, unknown>,
		auth: OwnerAuth,
		ifMatch: string | null
	): Promise<SettingsPatchAnswer>;
}

export const CONFIG_CHANGE_STATUSES = ['pending', 'applied', 'unverified', 'failed'] as const;
export type ConfigChangeStatus = (typeof CONFIG_CHANGE_STATUSES)[number];

// before and after are stored as the JSON text they were written as
export interface ConfigChangeRecord {
	id: string;
	organizationId: string;
	siteId: string;
	operationId: string;
	key: string;
	before: string;
	after: string;
	actor: string;
	status: ConfigChangeStatus;
	createdAt: number;
	revertedBy: string | null;
}

export interface ConfigLedger {
	forOperation(organizationId: string, operationId: string): Promise<ConfigChangeRecord[]>;
	// a row that already exists is left as it is, so a replay keeps the first reading
	begin(rows: readonly ConfigChangeRecord[]): Promise<void>;
	settle(organizationId: string, operationId: string, status: ConfigChangeStatus): Promise<void>;
	markReverted(
		organizationId: string,
		ids: readonly string[],
		operationId: string
	): Promise<void>;
}

export interface ConfigDeps extends BackupDeps {
	settings: SettingsWorker;
	changes: ConfigLedger;
}

// #endregion

// #region modules

export interface InstallVerdict {
	verdict: 'installable' | 'blocked' | 'unverifiable' | 'not-found';
	conflicts: { requires: string; constraint: string; installed: string | null; reason: string }[];
}

// what the site says about one module without changing anything
export interface ModuleReading {
	// the code is on the site's disk and Drupal can see it
	present: boolean;
	enabled: boolean;
}

// a route the site does not have yet answers not_available, never an error
export type UninstallAnswer =
	| { kind: 'not_available' }
	| {
			kind: 'plan';
			enabledModules: string[];
			dependents: string[];
			wouldDelete: string[];
	  }
	| { kind: 'removed' };

export type ThemeDefaultAnswer =
	{ kind: 'not_available' } | { kind: 'set'; default: string | null; admin: string | null };

// the site's owner routes for modules and themes; every call takes the owner token the caller opened
export interface ModuleWorker {
	installable(hostname: string, name: string, auth: OwnerAuth): Promise<InstallVerdict>;
	read(hostname: string, project: string, auth: OwnerAuth): Promise<ModuleReading>;
	// true when the site reports the package in place
	install(hostname: string, name: string, auth: OwnerAuth): Promise<{ ok: boolean }>;
	enable(hostname: string, project: string, auth: OwnerAuth): Promise<{ ok: boolean }>;
	// true when the site answers with the value that was asked for; a repeat writes nothing
	setStrata(
		hostname: string,
		captureStatements: boolean,
		auth: OwnerAuth
	): Promise<{ ok: boolean }>;
	// the refusal is the route's own answer: a site on an older worker has no route, and Strata or its
	// S3 part may be off. The request carries a secret, so no answer or error quotes it
	setStrataStore(
		hostname: string,
		store: StrataStoreRequest,
		auth: OwnerAuth
	): Promise<{ ok: boolean; refusal?: StrataStoreRefusal }>;
	// dryRun reports the plan and removes nothing
	uninstall(
		hostname: string,
		project: string,
		options: { dryRun: boolean },
		auth: OwnerAuth
	): Promise<UninstallAnswer>;
	// dryRun reads the current default and admin themes and changes nothing
	setDefaultTheme(
		hostname: string,
		change: { project: string; target: 'default' | 'admin' },
		options: { dryRun: boolean },
		auth: OwnerAuth
	): Promise<ThemeDefaultAnswer>;
}

export interface StrataStoreRequest {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	pathStyle: boolean;
	enable: boolean;
}

export type StrataStoreRefusal = 'route_missing' | 'strata_not_enabled' | 'strata_s3_not_enabled';

// a choice is marked applied only while it is still the stored one
export interface StrataStore {
	markApplied(
		organizationId: string,
		siteId: string,
		allocation: 'light' | 'detailed',
		now: number
	): Promise<void>;
	// the reason is a short code and never text from the site
	markStore(
		organizationId: string,
		siteId: string,
		store: { state: 'ready' } | { state: 'failed'; reason: string }
	): Promise<void>;
}

export interface ModuleDeps extends BackupDeps {
	modules: ModuleWorker;
	strata: StrataStore;
}

// #endregion

// #region modify

export interface ModifyFile {
	path: string;
	source: string;
	hash: string;
	bytes: number;
}

export type ModifyAnswer = { kind: 'applied'; rev: string } | { kind: 'refused'; reason: string };

// the site's owner route for uploaded module revisions; a revision is named by the hash of its
// file set, so sending the same set twice changes nothing
export interface ModifyWorker {
	// the revision the site runs for a package, null when it has none
	active(hostname: string, name: string, auth: OwnerAuth): Promise<string | null>;
	// sends only the files the site lacks, then commits the set; a refused commit leaves the old
	// revision running
	deliver(
		hostname: string,
		delivery: { name: string; label: string; files: readonly ModifyFile[] },
		auth: OwnerAuth
	): Promise<ModifyAnswer>;
	// puts a stored revision back as the running one
	activate(
		hostname: string,
		name: string,
		rev: string,
		auth: OwnerAuth
	): Promise<{ ok: boolean }>;
}

export interface EditRow {
	// derived from the operation, so a repeat writes nothing
	id: string;
	organizationId: string;
	siteId: string;
	bundleKey: string;
	note: string;
	now: number;
}

// the history row of an edit; the release it names is the one the site runs when the row is written
export interface EditLedger {
	record(row: EditRow): Promise<void>;
}

export interface ModifyDeps extends BackupDeps {
	modify: ModifyWorker;
	edits: EditLedger;
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

// #region the write count on the new site

export type ChangeDialect = 'mysql' | 'pgsql';
export type MarkIncomplete = 'journal_full' | 'capture_failed';

export interface MarkCount {
	mark: string;
	writes: number;
	incomplete: MarkIncomplete | null;
}

export interface ChangeManifest extends MarkCount {
	through: number;
	cannotCarry: string[];
}

// the changes as SQL, read once as they arrive; the site tells how far it read and whether it kept
// every change
export interface ChangeBody {
	stream: ReadableStream<Uint8Array>;
	through: number;
	// the write number the list starts after; -1 when the site did not say, which is a site that
	// ignores the field
	since: number;
	incomplete: MarkIncomplete | null;
}

// 'none' is a site that has the routes and no active mark; 'missing' is one that does not have them
export interface WriteMarkWorker {
	supported(hostname: string, auth: OwnerAuth): Promise<boolean>;
	start(
		hostname: string,
		mark: string,
		auth: OwnerAuth
	): Promise<'started' | 'existing' | 'taken' | 'missing'>;
	read(hostname: string, auth: OwnerAuth): Promise<MarkCount | 'none' | 'missing'>;
	end(hostname: string, mark: string, auth: OwnerAuth): Promise<void>;
	manifest(
		hostname: string,
		auth: OwnerAuth,
		through?: number
	): Promise<ChangeManifest | 'none' | 'missing'>;
	body(hostname: string, through: number, auth: OwnerAuth, since?: number): Promise<ChangeBody>;
}

// #endregion

export interface CutoverDestination {
	// null when the snapshot plus the delta load and match, otherwise the plain problem
	validate(key: string, snapshot: string, delta: string): Promise<string | null>;
	// counting is true when the new site opened the count with the copy, so no second call is owed
	promote(key: string, snapshot: string, delta: string): Promise<{ counting: boolean }>;
	// the address that moves, since the destination knows only its own
	route(key: string, to: 'destination' | 'source', hostname: string): Promise<void>;
	// starts counting the writes the new site accepts; a repeat with the same key changes nothing
	startCounting(key: string): Promise<void>;
	// ends the count so the site stops recording each write
	stopCounting(key: string): Promise<void>;
	acceptedWrites(key: string): Promise<number>;
	observe(key: string): Promise<{ healthy: boolean; writes: number }>;
	// the changes accepted since the count started, and what the path back to the source cannot
	// carry. The dialect is the one the old site's database speaks
	exportChanges(
		key: string,
		dialect: ChangeDialect
	): Promise<{ reference: string; cannotCarry: string[]; through: number }>;
	// the changes accepted after the first file's `through`, added to the same saved file as its
	// next parts. statements is 0 when nothing arrived since
	exportFinalChanges(
		key: string,
		dialect: ChangeDialect,
		since: number
	): Promise<{ cannotCarry: string[]; statements: number }>;
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
	// a mysqldump, one window at a time
	convertChunk(bytes: Uint8Array, last: boolean): Promise<ConvertedChunk>;
	// a pg_dump states a table across several statements and types a COPY row by its table, so it is
	// read in two passes: scan finds each cut and the statements that are not data, schema turns
	// those into the tables and the indexes, and data converts one cut with them
	scanPg(bytes: Uint8Array, last: boolean): Promise<{ cut: number; ddl: string }>;
	schemaPg(ddl: string): Promise<{ tables: string; indexes: string; lossy: string[] }>;
	dataPg(bytes: Uint8Array, ddl: string): Promise<ConvertedChunk>;
}

export type DumpDialect = 'mysql' | 'pgsql';

export interface DumpJob {
	kind: 'database' | 'files' | 'private';
	// the private files folder as the server reports it, for a private job
	path?: string;
	// what the database job dumps; mysql when absent
	dialect?: DumpDialect;
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

// #region repair

export interface RepairCall {
	method: 'GET' | 'POST';
	path: string;
}

export interface RepairAnswer {
	status: number;
	json: unknown;
}

// what the site shows now, read from its health and reconcile answers
export interface RepairReading extends HealthObservation {
	// undefined means the site did not say, which the ladder reads as unsafe
	transactionDepth: number | undefined;
	shedding: boolean;
	quarantined: boolean;
}

// the site's own owner routes; a refused token throws, any other answer comes back as a status
export interface RepairWorker {
	observe(hostname: string, auth: OwnerAuth): Promise<RepairReading>;
	call(hostname: string, call: RepairCall, auth: OwnerAuth): Promise<RepairAnswer>;
}

export interface NewRepair {
	id: string;
	organizationId: string;
	siteId: string;
	repairId: string;
	rung: string;
	status: RepairStatus;
	observationBefore: string;
	operationId: string;
	undoOf: string | null;
	createdAt: number;
	finishedAt: number | null;
}

export interface RepairLedger {
	// a row whose id exists is returned unchanged
	begin(row: NewRepair): Promise<RepairRecord>;
	// moves a running row to its end state; any other row stays as it is
	finish(
		organizationId: string,
		id: string,
		end: { status: RepairStatus; observationAfter: string | null; finishedAt: number }
	): Promise<void>;
	// marks a succeeded repair as undone; any other row stays as it is
	undone(organizationId: string, id: string): Promise<void>;
	get(organizationId: string, id: string): Promise<RepairRecord | null>;
	// newest first
	history(
		organizationId: string,
		siteId: string,
		repairId: string,
		limit: number
	): Promise<RepairRecord[]>;
	// repairs begun since the time given, for the repair budget; a refused one spent nothing
	since(sinceMs: number): Promise<{ orgId: string; atMs: number }[]>;
	switches(organizationId: string, siteId: string): Promise<LadderSwitches>;
}

export interface RepairDeps extends BackupDeps {
	repair: RepairWorker;
	repairs: RepairLedger;
	// whether a release is moving this site between rings
	ringPromotion(siteId: string): Promise<boolean>;
	budget: RepairBudget;
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
	// `unproven` means an unproven live claim holds the name and the challenger showed no proof
	| { ok: false; unproven?: boolean };

// whether the challenger's own ownership value is published for the epoch a takeover would use
export type ClaimProof = (epoch: number) => Promise<boolean>;

// one row per hostname that is never deleted, so its epoch only rises
export interface DomainLedger {
	site(siteId: string): Promise<DomainSite | null>;
	// with a proof, an unproven claim can be contested and an expired one is released; without one the
	// ledger behaves as it always did
	claim(
		hostname: string,
		who: { organizationId: string; siteId: string; operationId: string },
		now: number,
		proof?: ClaimProof
	): Promise<DomainClaim>;
	current(hostname: string): Promise<ClaimRow | null>;
	// each write names the epoch it was made under and does nothing when the hostname has moved on
	setProvider(hostname: string, epoch: number, providerId: string): Promise<boolean>;
	markRouted(hostname: string, epoch: number, siteId: string): Promise<boolean>;
	release(hostname: string, epoch: number, siteId: string): Promise<boolean>;
	// records that the owner proved the domain under this epoch
	proveOwnership(hostname: string, epoch: number, siteId: string): Promise<boolean>;
	// the claims a site holds that are not released
	heldBy(siteId: string): Promise<ClaimRow[]>;
}

export interface DomainDeps extends EngineDeps {
	hostnames: CustomHostnames;
	domains: DomainLedger;
	dns: DnsResolver;
	// the ownership value for a claim, derived from the key ring and never stored
	challenge(input: ChallengeInput): Promise<Challenge>;
	// the name visitors point at; null while custom domains are off
	target: string | null;
}

// #endregion

// #region nodes

// a paired box as the engine reads it, and the commands it takes through the node's session
export interface NodeFacts {
	id: string;
	orgId: string;
	state: 'active' | 'revoked';
	lastSeenAt: number | null;
}

export interface NodeCommands {
	node(nodeId: string): Promise<NodeFacts | null>;
	// the same operation, step and key is one command, so a repeat sends nothing new
	send(nodeId: string, request: CommandRequest): Promise<SendResult>;
	status(
		nodeId: string,
		ref: { opId: string; stepId: string; idempotencyKey: string }
	): Promise<CommandStatus>;
}

export interface NodeSiteRow {
	organizationId: string;
	plane: SitePlane;
	state: SiteRowState;
	readyAt: number | null;
	nodeId: string | null;
}

export interface NodeSites {
	get(siteId: string): Promise<NodeSiteRow | null>;
	// makes the site ready on this node; a repeat changes nothing
	bind(siteId: string, nodeId: string, releaseId: string, now: number): Promise<void>;
	// the site of a create that ended without a box site
	retire(siteId: string, now: number): Promise<void>;
}

export interface NodeSiteDeps extends EngineDeps {
	nodes: NodeCommands;
	sites: NodeSites;
	domains: Pick<DomainLedger, 'claim' | 'current' | 'markRouted' | 'release'>;
}

// #endregion

// #region estate

export interface EstateAssessmentFacts {
	state: string;
	rowCount: number;
	// JSON list of { server, credentialId }
	access: string;
}

export interface EstateStore {
	assessment(orgId: string, id: string): Promise<EstateAssessmentFacts | null>;
	numbers(orgId: string, id: string): Promise<number[]>;
	row(orgId: string, id: string, number: number): Promise<EstateRowRecord | null>;
	page(orgId: string, id: string, after: number, count: number): Promise<EstateRowRecord[]>;
	// moves the assessment from preparing to running; a repeat changes nothing
	start(orgId: string, id: string, now: number): Promise<void>;
	begin(orgId: string, id: string, number: number, now: number): Promise<void>;
	finishRow(
		orgId: string,
		id: string,
		number: number,
		verdict: RowVerdict,
		now: number
	): Promise<void>;
	// rows that never started or never finished become skipped
	skip(orgId: string, id: string, now: number): Promise<void>;
	finish(
		orgId: string,
		id: string,
		report: EstateReport | null,
		state: 'finished' | 'failed',
		now: number
	): Promise<void>;
}

export interface EstateDeps extends ImportDeps {
	estate: EstateStore;
	// the public URL-only check for one hostname
	preflight(hostname: string): Promise<PreflightResult>;
}

// #endregion

// #region rollback

export interface RollbackFacts {
	// null when the site never recorded one
	dataSchemaVersion: number | null;
	// null when the release is not registered
	target: { schemaVersion: number; acceptsSchema: number } | null;
}

export interface RollbackDeps extends EngineDeps {
	rollbackFacts(siteId: string, targetId: string): Promise<RollbackFacts>;
}

// #endregion

// #region rollout

export type MoveStatus = 'running' | 'succeeded' | 'failed';

// starts site.upgrade and site.rollback for one site; a repeat with the same key starts nothing new
export interface SiteMover {
	// the release the site runs now, null when the row does not say
	current(siteId: string): Promise<string | null>;
	upgrade(site: { id: string; plan: string }, releaseId: string, key: string): Promise<string>;
	rollback(site: { id: string; plan: string }, releaseId: string, key: string): Promise<string>;
	status(operationId: string): Promise<MoveStatus>;
}

export interface RingProgress {
	upgraded: string[];
	failed: string[];
	reverted: string[];
	// sites a revert could not put back, with the plain reason
	stuck: string[];
}

export interface StoredRollout {
	id: string;
	releaseId: string;
	state: RolloutState;
	progress: Record<string, RingProgress>;
	// the release each site ran before this rollout moved it
	previous: Record<string, string | null>;
	firstRingAt: number | null;
	lastRingAt: number | null;
}

export interface RolloutStore {
	load(id: string): Promise<StoredRollout | null>;
	save(rollout: StoredRollout): Promise<void>;
	stopRequested(id: string): Promise<boolean>;
}

export interface RingProbe {
	ring: Ring;
	releaseId: string;
	siteIds: string[];
	// the synthetic sites among them
	syntheticIds: string[];
}

// reads what the ring's sites report now; a field it cannot read stays out of the answer
export type ObserveRing = (probe: RingProbe) => Promise<RingObservation>;

export interface RolloutDeps extends EngineDeps {
	mover: SiteMover;
	rollouts: RolloutStore;
	observe: ObserveRing;
}

// #endregion

// #region templates

// the job runner answers with the record of the run, or with the reason it refused the job
export type TemplateJobAnswer = RunRecord | RunRefusal;

export interface TemplateRunner {
	run(request: { key: string; input: Uint8Array }): Promise<TemplateJobAnswer>;
}

export interface TemplateStore {
	ready(id: string, patch: { bundleKey: string; manifest: string }): Promise<void>;
	fail(id: string, failure: string): Promise<void>;
}

export interface TemplateBuildDeps {
	jobs: TemplateRunner;
	blobs: BackupBlobs;
	templates: TemplateStore;
}

// a create from a template restores the bundle's database into the new site
export interface TemplateCreateDeps extends EngineDeps {
	worker: BackupWorker;
	blobs: BackupBlobs;
	sleep(ms: number): Promise<void>;
}

// #endregion

export interface EngineConfig {
	leaseTtlMs: number;
	chunkBytes: number;
	assetSessionMs: number;
	limits: BundleLimits;
	account?: { kvNamespaces: number; buckets?: number; scripts?: number };
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
	// set only when the deps run against a customer's account
	account?: AccountHosts;
	now(): number;
	config: EngineConfig;
}

export type { BundleManifest };
