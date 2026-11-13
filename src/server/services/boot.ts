import type { R2Bucket } from '@cloudflare/workers-types';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { CUTOVER_MISSING_CONTRACTS } from '../../../engine/src/adapters/cutover-destination';
import { CryptoError, loadKeyRing, type KeyRing } from '../../shared/custody/envelope';
import { ApiError } from '../../shared/errors';
import { PLATFORM_ROLE_PERMISSIONS } from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { ensureCollegeDB, type CollegeDBEnv } from '../db/collegedb';
import { personalOrganizationId } from '../db/repos/accounts';
import { withAtomicBatch } from '../db/repos/atomic-shards';
import { getUserById } from '../db/repos/identity';
import { findSiteHome } from '../db/repos/site-lookup';
import type { Principal } from '../domain/authorize';
import { entitlementKeys } from '../domain/entitlements';
import { renderMail } from '../emails';
import { cloudflareEmailSender, type EmailBinding } from '../integrations/email';
import { engineConfigOf, engineEventSender, engineStarter } from '../integrations/engine';
import { guardedProviderFetch } from '../integrations/git-providers/guard';
import { OAUTH_PROVIDERS, oauthClients, type OAuthConfig } from '../integrations/oauth';
import { probeHostKey } from '../integrations/ssh-key';
import { dohResolve } from '../integrations/url-guard';
import type { WebAuthnConfig } from '../integrations/webauthn';
import { accessConfigOf, accessTokenOf, verifyAccessToken } from '../utils/access';
import {
	collegeKeyIndex,
	createPrincipalResolver,
	setAuthServices,
	siteverifyTurnstile,
	type AuthServices
} from '../utils/auth';
import { resetApiDeps, setApiDeps, type ApiDeps } from '../utils/define-api';
import { collegeIdempotencyStore } from '../utils/idempotency';
import { append, appendBoth, r2HeadStore, type HeadStore } from './audit';
import { collegeDirectory } from './auth';
import {
	backupServicesOf,
	resetBackupServices,
	setBackupServices,
	type BackupServices
} from './backups';
import { collegeBillingStore, entitlementOf } from './billing';
import {
	cloudflareReadsOf,
	resetCapacityServices,
	setCapacityServices,
	type CapacityServices
} from './capacity';
import { collegeAttemptStore, consoleMailSender, type MailSender } from './email-codes';
import { resetEstateServices, setEstateServices } from './estate';
import { collegeFactsStore, factsLoader, type FactsDeps } from './facts';
import { fleetConfigOf, resetFleetServices, setFleetServices, type FleetServices } from './fleet';
import { startGitPull } from './git-pull';
import { collegeIdentityStore, setIdentityServices, type IdentityServices } from './identities';
import { setKeyServices, type KeyServices } from './key-admin';
import {
	resetCutoverServices,
	setCutoverServices,
	type CutoverServices
} from './migration-cutover';
import { setOrganizationServices, type OrganizationServices } from './organizations';
import {
	collegeOwnerTokenStore,
	collegePendingSecretStore,
	principalActor,
	resetPendingSecretDeps,
	setPendingSecretDeps,
	type AuditSink,
	type OwnerTokenStore,
	type PendingSecretDeps
} from './owner-tokens';
import {
	collegeRepoStore,
	setRepoConnectionDeps,
	type RepoConnectionDeps
} from './repo-connections';
import { collegeOnceStore } from './single-use';
import {
	domainServicesOf,
	resetDomainServices,
	setDomainServices,
	type DomainServices
} from './site-domain';
import {
	resetSiteHealthServices,
	setSiteHealthServices,
	type SiteHealthServices
} from './site-health';
import { resetImportServices, setImportServices, type ImportServices } from './site-import';
import { siteInputConfigOf } from './site-input';
import {
	collegeBudgets,
	collegeSiteEntitlements,
	resetSiteServices,
	setSiteServices,
	type SiteServices
} from './sites';

export interface BootEnv extends CollegeDBEnv {
	BLOB?: R2Bucket;
	EMAIL?: unknown;
	ENGINE?: unknown;
}

export interface BootOptions {
	// the console mail sender prints sign-in codes, so only a development server may ask for it
	dev?: boolean;
	baseUrl?: string;
	// public client ids the build carries in the runtime config, by provider
	oauthClientIds?: Partial<Record<string, string>>;
	// the GitHub App values the build carries in the runtime config; a Worker secret of the same
	// NUXT_ name wins
	githubApp?: {
		appId?: string;
		clientId?: string;
		slug?: string;
		privateKey?: string;
		clientSecret?: string;
		webhookSecret?: string;
	};
	// the entitlement, budget, policy, suspension and support ports; each defaults to empty
	facts?: Omit<FactsDeps, 'store'>;
}

export class BootError extends Error {
	readonly code = 'BOOT';

	constructor(message: string) {
		super(message);
		this.name = 'BootError';
	}
}

// #region configuration

const text = (env: BootEnv, name: string): string | undefined => {
	const value = env[name];
	return typeof value === 'string' && value !== '' ? value : undefined;
};

export function webauthnConfig(env: BootEnv, baseUrl: string): WebAuthnConfig {
	const url = new URL(baseUrl);
	return {
		rpId: text(env, 'WEBAUTHN_RP_ID') ?? url.hostname,
		rpName: text(env, 'WEBAUTHN_RP_NAME') ?? 'Drupflare',
		origin: text(env, 'WEBAUTHN_ORIGIN') ?? url.origin
	};
}

// a provider with any of the three missing is left out and answers 501
// the client id is public and the secret is private; crust names them NUXT_PUBLIC_<P>_CLIENT_ID and
// NUXT_<P>_CLIENT_SECRET, so one .env and one .dev.vars serve both, and the redirect is /auth/callback
export function oauthConfig(
	env: BootEnv,
	appUrl = 'https://app.drupflare.com',
	clientIds: Partial<Record<string, string>> = {}
): OAuthConfig {
	const config: OAuthConfig = {};
	for (const provider of OAUTH_PROVIDERS) {
		const name = provider.toUpperCase();
		const prefix = `OAUTH_${name}`;
		const clientId =
			text(env, `${prefix}_CLIENT_ID`) ??
			(clientIds[provider] || undefined) ??
			text(env, `NUXT_PUBLIC_${name}_CLIENT_ID`);
		const clientSecret =
			text(env, `${prefix}_CLIENT_SECRET`) ?? text(env, `NUXT_${name}_CLIENT_SECRET`);
		const redirectUri = text(env, `${prefix}_REDIRECT_URI`) ?? `${appUrl}/auth/callback`;
		if (!clientId || !clientSecret || !redirectUri) continue;
		const baseUrl = provider === 'gitlab' ? text(env, `${prefix}_BASE_URL`) : undefined;
		const tenant = provider === 'microsoft' ? text(env, `${prefix}_TENANT`) : undefined;
		config[provider] = {
			clientId,
			clientSecret,
			redirectUri,
			...(baseUrl ? { baseUrl } : {}),
			...(tenant ? { tenant } : {})
		};
	}
	return config;
}

export const GITHUB_APP_SLUG = 'drupflare';

// the app needs all six values; with any missing it is left out and its routes answer 501
export function githubAppOf(
	env: BootEnv,
	values: NonNullable<BootOptions['githubApp']> = {}
): RepoConnectionDeps['github'] {
	const appId = text(env, 'NUXT_PUBLIC_GITHUB_APP_ID') ?? (values.appId || undefined);
	const clientId =
		text(env, 'NUXT_PUBLIC_GITHUB_APP_CLIENT_ID') ?? (values.clientId || undefined);
	const clientSecret =
		text(env, 'NUXT_GITHUB_APP_CLIENT_SECRET') ?? (values.clientSecret || undefined);
	const webhookSecret =
		text(env, 'NUXT_GITHUB_APP_WEBHOOK_SECRET') ?? (values.webhookSecret || undefined);
	// a secret set from one line carries the PEM's newlines as the two characters \n
	const privateKey = (
		text(env, 'NUXT_GITHUB_APP_PRIVATE_KEY') ??
		(values.privateKey || undefined)
	)?.replaceAll('\\n', '\n');
	if (!appId || !clientId || !clientSecret || !webhookSecret || !privateKey) return null;
	return {
		appId,
		clientId,
		clientSecret,
		webhookSecret,
		privateKey,
		slug: text(env, 'NUXT_PUBLIC_GITHUB_APP_SLUG') ?? (values.slug || GITHUB_APP_SLUG)
	};
}

// admin needs both halves: the role on the user record and an Access login for the same address
export function platformStanding(
	getDb: () => Promise<CollegeDBClient>
): NonNullable<FactsDeps['platform']> {
	return async ({ userId, access }) => {
		const user = await getUserById(await getDb(), userId);
		if (!user || user.platformRole === null) return null;
		return {
			admin: true,
			access: access !== null && access.email === user.email,
			permissions: PLATFORM_ROLE_PERMISSIONS[user.platformRole]
		};
	};
}

// the module and crust name it NUXT_TURNSTILE_SECRET_KEY, so one .dev.vars line serves both
export const turnstileSecretOf = (env: BootEnv): string | undefined =>
	text(env, 'TURNSTILE_SECRET_KEY') ?? text(env, 'NUXT_TURNSTILE_SECRET_KEY');

const DEFAULT_MAIL_FROM = 'no-reply@drupflare.com';

function emailBindingOf(value: unknown): EmailBinding | undefined {
	const send = (value as { send?: unknown } | undefined)?.send;
	return typeof send === 'function' ? (value as EmailBinding) : undefined;
}

// a bound EMAIL sends through Email Sending; with none, only a development server may print codes
export function mailFor(env: BootEnv, options: BootOptions): MailSender {
	const binding = emailBindingOf(env.EMAIL);
	if (binding !== undefined) {
		const sender = cloudflareEmailSender(binding, {
			email: text(env, 'MAIL_FROM') ?? DEFAULT_MAIL_FROM,
			name: 'Drupflare'
		});
		return {
			send: (to, template) => sender.send(to, renderMail({ ...template, purpose: 'sign-in' }))
		};
	}
	if (options.dev === true) return consoleMailSender();
	return {
		async send() {
			throw new ApiError('not_built', 'Mail is not available yet');
		}
	};
}

// #endregion

// #region audit

// an account-level refusal has no organisation, so it goes to the person's own chain
function denialChain(principal: Principal, orgId: string | undefined): string {
	if (orgId !== undefined) return orgId;
	return personalOrganizationId(
		principal.kind === 'user' ? principal.userId : principal.issuerId
	);
}

export function auditWriters(
	getDb: () => Promise<CollegeDBClient>,
	heads: HeadStore
): Pick<ApiDeps, 'audit' | 'auditDenied'> {
	return {
		async audit(record) {
			const db = await getDb();
			const input = {
				actor: principalActor(record.principal),
				action: record.action,
				target: record.resource.siteId ?? record.resource.orgId ?? record.action,
				detail: {
					via: record.via,
					method: record.method,
					path: record.path,
					requestId: record.requestId
				}
			};
			const ids = [...new Set(record.orgIds)];
			const [first, second] = ids;
			if (ids.length === 2 && first && second) {
				await appendBoth(db, first, second, input, heads);
				return;
			}
			for (const id of ids) await append(db, id, input, heads);
		},
		async auditDenied(record) {
			const chain = denialChain(record.principal, record.resource.orgId);
			await append(
				await getDb(),
				chain,
				{
					actor: principalActor(record.principal),
					action: `${record.action}.denied`,
					target: record.resource.siteId ?? record.resource.orgId ?? record.action,
					detail: {
						reason: record.reason,
						...(record.detail ? { rule: record.detail } : {}),
						method: record.method,
						path: record.path,
						requestId: record.requestId
					}
				},
				heads
			);
		}
	};
}

// #endregion

// #region shards

// the engine writes owner tokens, pending secrets, operations and sites to its one DB binding, and
// the dashboard reads them by hashing the id over every shard. They meet only while one shard is bound
export function assertSingleShard(env: CollegeDBEnv): void {
	const bound = Object.keys(env).filter((name) => /^DB(_\d+)?$/.test(name));
	if (bound.length > 1) {
		throw new BootError(
			`${bound.length} D1 shards are bound (${bound.join(', ')}) but the engine writes to DB only; bind one shard`
		);
	}
}

// the audit row of a secret reveal goes to the chain of the organisation that owns the site
function siteAuditSink(getDb: () => Promise<CollegeDBClient>, heads: HeadStore): AuditSink {
	return {
		async append(input) {
			const db = await getDb();
			const home = await findSiteHome(db, input.target);
			if (!home) throw new ApiError('not_found', 'Not found');
			return append(db, home.organizationId, input, heads);
		}
	};
}

// #endregion

// #region build

export interface BuiltServices {
	auth: AuthServices;
	identity: IdentityServices;
	organizations: OrganizationServices;
	keys: KeyServices;
	api: Partial<ApiDeps>;
	ownerTokens: OwnerTokenStore;
	sites: SiteServices;
	backups: BackupServices;
	cutover: Partial<CutoverServices>;
	fleet: FleetServices;
	imports: Partial<ImportServices>;
	siteHealth: Partial<SiteHealthServices>;
	capacity: Partial<CapacityServices>;
	repoConnections: RepoConnectionDeps;
	domain: DomainServices;
	pendingSecrets: () => Promise<PendingSecretDeps>;
	heads: HeadStore;
}

// every store comes from a binding: sessions from KV, the rest from D1, and the audit chain heads
// from R2. A missing binding stops the build, so nothing falls back to memory
export function buildServices(env: BootEnv, options: BootOptions = {}): BuiltServices {
	if (!env.KV) throw new BootError('the KV binding is missing');
	if (!env.BLOB) throw new BootError('the BLOB binding is missing');
	assertSingleShard(env);
	const getDb = () => ensureCollegeDB(withAtomicBatch(env));
	const heads = r2HeadStore(env.BLOB);
	const baseUrl = options.baseUrl ?? 'https://app.drupflare.com';
	const billing = collegeBillingStore(getDb);
	const planOf = async (orgId: string) => entitlementOf(await billing.getAccount(orgId));
	const billingAccountOf = async (orgId: string) =>
		Boolean((await billing.getAccount(orgId))?.stripeCustomerId);
	const startOperation = engineStarter({ ...engineConfigOf(env), now: Date.now });
	const ownerTokens = collegeOwnerTokenStore(getDb);
	let ring: Promise<KeyRing> | undefined;
	// the key ring loads on first use, and a missing KEK_V<n> answers 501 until one is set
	const pendingSecrets = async (): Promise<PendingSecretDeps> => {
		ring ??= loadKeyRing(env as Record<string, string | undefined>);
		try {
			return {
				store: collegePendingSecretStore(getDb),
				audit: siteAuditSink(getDb, heads),
				ring: await ring,
				now: Date.now
			};
		} catch (error) {
			ring = undefined;
			if (error instanceof CryptoError && error.code === 'no_keys') {
				throw new ApiError('not_built', 'Secret custody is not available yet');
			}
			throw error;
		}
	};
	const siteServices: SiteServices = {
		getDb,
		entitlements: collegeSiteEntitlements(getDb, billing),
		planOf,
		billingAccountOf,
		startOperation,
		config: siteInputConfigOf(env)
	};
	return {
		auth: {
			kv: env.KV,
			once: collegeOnceStore(getDb),
			attempts: collegeAttemptStore(getDb),
			directory: collegeDirectory(getDb, heads),
			mail: mailFor(env, options),
			turnstile: siteverifyTurnstile(turnstileSecretOf(env)),
			codeSecret: text(env, 'AUTH_CODE_SECRET') ?? '',
			keys: collegeKeyIndex(getDb)
		},
		identity: {
			store: collegeIdentityStore(getDb),
			webauthn: webauthnConfig(env, baseUrl),
			clients: oauthClients(oauthConfig(env, baseUrl, options.oauthClientIds)),
			fetch: (input, init) => fetch(input, init)
		},
		organizations: { getDb },
		keys: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: () => nowUtc().toMillis()
		},
		api: {
			resolvePrincipal: createPrincipalResolver(),
			idempotency: collegeIdempotencyStore(getDb),
			load: factsLoader({
				entitlements: async (orgId) => entitlementKeys(await planOf(orgId)),
				budgets: collegeBudgets(getDb),
				platform: platformStanding(getDb),
				...options.facts,
				store: collegeFactsStore(getDb)
			}),
			access: (event) =>
				verifyAccessToken(
					accessTokenOf(event),
					accessConfigOf(text(env, 'ACCESS_TEAM'), text(env, 'ACCESS_AUD'))
				),
			...auditWriters(getDb, heads)
		},
		ownerTokens,
		sites: siteServices,
		backups: backupServicesOf({ BLOB: env.BLOB }, { getDb, startOperation }, heads, {
			pagedRestore: text(env, 'PAGED_RESTORE') === 'on'
		}),
		cutover: {
			sendEvent: engineEventSender({ ...engineConfigOf(env), now: Date.now }),
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			blobs: {
				async get(key) {
					const object = await env.BLOB!.get(key);
					return object === null ? null : new Uint8Array(await object.arrayBuffer());
				}
			},
			adaptersBuilt: CUTOVER_MISSING_CONTRACTS.length === 0
		},
		fleet: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			baseUrl,
			now: Date.now,
			...fleetConfigOf(env)
		},
		imports: {
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			ring: async () => (await pendingSecrets()).ring,
			resolve: (hostname) => dohResolve(hostname),
			// the connection library loads on the first probe, so no other request pays for it
			probe: async (target) =>
				probeHostKey(
					(await import('../../../engine/src/adapters/edgeport-ssh')).edgeportConnector,
					target
				),
			now: Date.now
		},
		siteHealth: {
			getDb,
			custody: async () => {
				const pending = await pendingSecrets();
				return { store: ownerTokens, audit: pending.audit, ring: pending.ring };
			}
		},
		capacity: {
			getDb,
			reads: cloudflareReadsOf(
				{
					accountId: text(env, 'MANAGED_ACCOUNT_ID'),
					token: text(env, 'CF_BILLING_TOKEN')
				},
				(input, init) => fetch(input, init)
			)
		},
		repoConnections: {
			store: collegeRepoStore(getDb),
			once: collegeOnceStore(getDb),
			ring: async () => (await pendingSecrets()).ring,
			fetch: guardedProviderFetch({
				fetch: (input, init) => fetch(input, init),
				resolve: (hostname) => dohResolve(hostname)
			}),
			resolve: (hostname) => dohResolve(hostname),
			now: Date.now,
			github: githubAppOf(env, options.githubApp),
			gitlab: null,
			pullRemote: (remote, trigger) => startGitPull(siteServices, remote, trigger.key),
			audit: async (orgId, action, targetId) => {
				await append(
					await getDb(),
					orgId,
					{ actor: 'dashboard', action, target: targetId },
					heads
				);
			}
		},
		domain: domainServicesOf({
			secrets: env as Record<string, string | undefined>,
			target: text(env, 'CUSTOM_HOSTNAME_TARGET')
		}),
		pendingSecrets,
		heads
	};
}

let booted: BuiltServices | null = null;

// installs the services once per isolate; a second call, whatever its env, changes nothing
export function bootOnce(env: BootEnv, options: BootOptions = {}): BuiltServices {
	if (booted) return booted;
	const built = buildServices(env, options);
	setAuthServices(built.auth);
	setIdentityServices(built.identity);
	setOrganizationServices(built.organizations);
	setKeyServices(built.keys);
	setApiDeps(built.api);
	setSiteServices(built.sites);
	setBackupServices(built.backups);
	setCutoverServices(built.cutover);
	setFleetServices(built.fleet);
	setImportServices(built.imports);
	setSiteHealthServices(built.siteHealth);
	setCapacityServices(built.capacity);
	setRepoConnectionDeps(built.repoConnections);
	setDomainServices(built.domain);
	setEstateServices({ keys: built.domain.keys, dns: built.domain.resolver });
	setPendingSecretDeps(built.pendingSecrets);
	booted = built;
	return built;
}

export function bootedServices(): BuiltServices {
	if (!booted) throw new ApiError('not_built', 'The services are not installed yet');
	return booted;
}

export function resetBoot(): void {
	booted = null;
	setAuthServices(null);
	setIdentityServices(null);
	setOrganizationServices(null);
	setKeyServices(null);
	resetApiDeps();
	resetSiteServices();
	resetBackupServices();
	resetCutoverServices();
	resetFleetServices();
	resetImportServices();
	resetSiteHealthServices();
	resetCapacityServices();
	setRepoConnectionDeps(null);
	resetDomainServices();
	resetEstateServices();
	resetPendingSecretDeps();
}

// #endregion
