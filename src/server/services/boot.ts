import type { R2Bucket } from '@cloudflare/workers-types';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { r2BackupBlobs } from '../../../engine/src/adapters/backups';
import { CUTOVER_MISSING_CONTRACTS } from '../../../engine/src/adapters/cutover-destination';
import { CryptoError, loadKeyRing, type KeyRing } from '../../shared/custody/envelope';
import { ApiError } from '../../shared/errors';
import { PLATFORM_ROLE_PERMISSIONS } from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { ensureCollegeDB, type CollegeDBEnv } from '../db/collegedb';
import { personalOrganizationId } from '../db/repos/accounts';
import { withAtomicBatch } from '../db/repos/atomic-shards';
import { collegeStateLedger } from '../db/repos/budget-states';
import { collegeBudgetSource } from '../db/repos/budgets';
import { getUserById } from '../db/repos/identity';
import { countMailSentSince, recordMail, recordMailSent } from '../db/repos/mail-log';
import { appendPlatformAudit } from '../db/repos/platform-audit';
import { isPlatformFlagOn } from '../db/repos/platform-flags';
import { loadPolicyFor } from '../db/repos/policies';
import { findSiteHome } from '../db/repos/site-lookup';
import type { Principal } from '../domain/authorize';
import { entitlementKeys } from '../domain/entitlements';
import { renderMail } from '../emails';
import { dohResolver } from '../integrations/dns-resolver';
import { cloudflareEmailSender, type EmailBinding } from '../integrations/email';
import { engineConfigOf, engineEventSender, engineStarter } from '../integrations/engine';
import {
	budgetConfigured,
	countsConfigured,
	engineBatchConfigOf,
	engineBudgetWriter,
	engineCountsReaders
} from '../integrations/engine-batch';
import { guardedProviderFetch } from '../integrations/git-providers/guard';
import { OAUTH_PROVIDERS, oauthClients, type OAuthConfig } from '../integrations/oauth';
import { createJwksCache } from '../integrations/oidc';
import { probeHostKey } from '../integrations/ssh-key';
import { STRIPE_SECRET_NAMES, createStripeClient } from '../integrations/stripe';
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
import { resetAccessServices, setAccessServices, type AccessServices } from './access-rules';
import { append, appendBoth, r2HeadStore, type HeadStore } from './audit';
import { collegeDirectory } from './auth';
import {
	backupServicesOf,
	resetBackupServices,
	setBackupServices,
	type BackupServices
} from './backups';
import {
	billingFlags,
	collegeBillingStore,
	entitlementOf,
	setBillingServices,
	type BillingServices,
	type BillingStore
} from './billing';
import {
	DAILY_MAIL_CAP,
	budgetAlertSink,
	collegeAlertStore,
	collegeNames,
	collegeRecipients
} from './budget-alerts';
import { budgetModeOf, type BudgetMode } from './budget-enforcement';
import {
	collegeBudgetStore,
	seedOrgBudgetFor,
	setBudgetServices,
	type BudgetServices
} from './budgets';
import {
	cloudflareReadsOf,
	resetCapacityServices,
	setCapacityServices,
	type CapacityServices
} from './capacity';
import { setClientServices, type ClientServices } from './client-workspaces';
import { setContactServices, type ContactMail, type ContactServices } from './contacts';
import { setCostCenterServices, type CostCenterServices } from './cost-centers';
import {
	resetCustomBundleServices,
	setCustomBundleServices,
	type CustomBundleServices
} from './custom-bundles';
import { setDelegationServices, type DelegationServices } from './delegations';
import {
	defaultDepartmentServices,
	setDepartmentServices,
	type DepartmentServices
} from './departments';
import { collegeAttemptStore, consoleMailSender, type MailSender } from './email-codes';
import { resetEstateServices, setEstateServices } from './estate';
import { collegeFactsStore, factsLoader, loadFacts, type FactsDeps } from './facts';
import { fleetConfigOf, resetFleetServices, setFleetServices, type FleetServices } from './fleet';
import { startGitPull } from './git-pull';
import { setGovernanceServices, type GovernanceServices } from './governance';
import { collegeIdentityStore, setIdentityServices, type IdentityServices } from './identities';
import { setKeyServices, type KeyServices } from './key-admin';
import { setLadderServices, type LadderServices } from './ladder';
import { setMembersServices, type InviteMail, type MembersServices } from './members';
import {
	resetCutoverServices,
	setCutoverServices,
	type CutoverServices
} from './migration-cutover';
import { resetModifyServices, setModifyServices, type ModifyServices } from './modify';
import { resetModuleServices, setModuleServices, type ModuleServices } from './modules';
import {
	setPreferenceServices,
	unsubscribeUrlFor,
	type PreferenceServices
} from './notification-preferences';
import { isEssential } from './notifications';
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
import { setPilotServices, type PilotServices } from './pilots';
import { setPlaneConnectionDeps, type PlaneConnectionDeps } from './plane-connections';
import { defaultPolicyServices, setPolicyServices, type PolicyServices } from './policies';
import { setProcurementServices, type ProcurementServices } from './procurement';
import { setReleaseServices, type ReleaseServices } from './releases';
import {
	collegeRepoStore,
	setRepoConnectionDeps,
	type RepoConnectionDeps
} from './repo-connections';
import { collegeReviewers, reviewMailer } from './review-mail';
import { collegeOnceStore } from './single-use';
import {
	domainServicesOf,
	resetDomainServices,
	setDomainServices,
	type DomainServices
} from './site-domain';
import { setSiteGrantServices, type SiteGrantServices } from './site-grants';
import {
	resetSiteHealthServices,
	setSiteHealthServices,
	type SiteHealthServices
} from './site-health';
import { resetImportServices, setImportServices, type ImportServices } from './site-import';
import { siteInputConfigOf } from './site-input';
import {
	resetSiteSettingsServices,
	setSiteSettingsServices,
	type SiteSettingsServices
} from './site-settings';
import {
	collegeBudgets,
	collegeSiteEntitlements,
	resetSiteServices,
	setSiteServices,
	type SiteServices
} from './sites';
import { collegeSsoMembers, collegeSsoStore, setSsoServices, type SsoServices } from './sso';
import { setSupportServices, supportStanding, type SupportServices } from './support';
import { setTransferServices, type TransferServices } from './transfers';
import { setTrustServices, type TrustBlobs, type TrustServices } from './trust';
import { setUsageServices, usageReadsOf, type UsageServices } from './usage';
import {
	productionSites,
	productionUsageStore,
	setUsageCollectFactory,
	type UsageCollectDeps
} from './usage-collect';

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
	// the shared secret the release sender signs its events with; a Worker secret of the same NUXT_ name wins
	releaseHook?: { secret?: string };
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

// an essential invitation mail; with no email binding only a development server prints it
export function inviteMailOf(env: BootEnv, options: BootOptions): InviteMail {
	const binding = emailBindingOf(env.EMAIL);
	if (binding === undefined) {
		return async (to, input) => {
			if (options.dev === true)
				console.info(`[dev mail] invitation to ${to}: ${input.acceptUrl}`);
		};
	}
	const sender = cloudflareEmailSender(binding, {
		email: text(env, 'MAIL_FROM') ?? DEFAULT_MAIL_FROM,
		name: 'Drupflare'
	});
	return (to, input) => sender.send(to, renderMail({ kind: 'invitation', ...input }));
}

// no binding outside development is an error, so a test notice never reports a send that did not happen
export function contactMailOf(env: BootEnv, options: BootOptions): ContactMail {
	const binding = emailBindingOf(env.EMAIL);
	if (binding === undefined) {
		return {
			async send(to, input) {
				if (options.dev !== true)
					throw new ApiError('not_built', 'Mail is not available yet');
				console.info(`[dev mail] ${input.kind} to ${to}`);
			}
		};
	}
	const sender = cloudflareEmailSender(binding, {
		email: text(env, 'MAIL_FROM') ?? DEFAULT_MAIL_FROM,
		name: 'Drupflare'
	});
	return { send: (to, input) => sender.send(to, renderMail(input)) };
}

export function trustBlobsOf(bucket: R2Bucket): TrustBlobs {
	return {
		async put(key, bytes, contentType) {
			await bucket.put(key, bytes, { httpMetadata: { contentType } });
		},
		async open(key) {
			const object = await bucket.get(key);
			return object === null ? null : (object.body as ReadableStream);
		}
	};
}

// an essential security-event mail; with no email binding only a development server prints it
export function securityMailOf(
	env: BootEnv,
	options: BootOptions,
	baseUrl: string
): SsoServices['notify'] {
	const binding = emailBindingOf(env.EMAIL);
	if (binding === undefined) {
		return async (to, summary) => {
			if (options.dev === true)
				console.info(`[dev mail] security-event to ${to}: ${summary}`);
		};
	}
	const sender = cloudflareEmailSender(binding, {
		email: text(env, 'MAIL_FROM') ?? DEFAULT_MAIL_FROM,
		name: 'Drupflare'
	});
	return (to, summary, reviewPath) =>
		sender.send(
			to,
			renderMail({
				kind: 'security-event',
				summary,
				occurredAt: new Date().toISOString(),
				reviewUrl: `${baseUrl}${reviewPath}`
			})
		);
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
			// a use of support access is visible to the customer and to the platform
			if (record.via === 'support-grant' || record.via === 'break-glass') {
				await appendPlatformAudit(db, {
					actor: input.actor,
					action: record.action,
					target: input.target,
					detail: { ...input.detail, organizationIds: ids },
					now: Date.now()
				});
			}
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
	sso: SsoServices;
	costCenters: CostCenterServices;
	delegations: DelegationServices;
	transfers: TransferServices;
	clients: ClientServices;
	pilots: PilotServices;
	trust: TrustServices;
	procurement: ProcurementServices;
	contacts: ContactServices;
	preferences: PreferenceServices;
	organizations: OrganizationServices;
	keys: KeyServices;
	members: MembersServices;
	departments: DepartmentServices;
	governance: GovernanceServices;
	policies: PolicyServices;
	support: SupportServices;
	siteGrants: SiteGrantServices;
	usageViews: UsageServices;
	api: Partial<ApiDeps>;
	ownerTokens: OwnerTokenStore;
	sites: SiteServices;
	backups: BackupServices;
	access: AccessServices;
	ladder: LadderServices;
	modules: Partial<ModuleServices>;
	modify: Partial<ModifyServices>;
	customBundles: Partial<CustomBundleServices>;
	cutover: Partial<CutoverServices>;
	fleet: FleetServices;
	imports: Partial<ImportServices>;
	siteHealth: Partial<SiteHealthServices>;
	siteSettings: Partial<SiteSettingsServices>;
	capacity: Partial<CapacityServices>;
	repoConnections: RepoConnectionDeps;
	planeConnections: PlaneConnectionDeps;
	releases: ReleaseServices;
	domain: DomainServices;
	pendingSecrets: () => Promise<PendingSecretDeps>;
	heads: HeadStore;
	// null without a Stripe secret, so the billing routes keep answering 501
	billing: BillingServices | null;
	budgets: BudgetServices;
	// null while the engine binding is missing or no counts secret resolves (the start secret is the fallback)
	usageCollect: () => UsageCollectDeps | null;
}

// a missing Stripe secret leaves billing uninstalled; a missing webhook secret leaves only the webhook off
export function billingServicesOf(
	env: BootEnv,
	deps: {
		store: BillingStore;
		audit: BillingServices['audit'];
		baseUrl: string;
		now?: () => number;
		onActivated?: BillingServices['onActivated'];
	}
): BillingServices | null {
	const secretKey = text(env, STRIPE_SECRET_NAMES.secretKey);
	if (secretKey === undefined) return null;
	return {
		stripe: createStripeClient(secretKey),
		webhookSecret: text(env, STRIPE_SECRET_NAMES.webhookSecret) ?? null,
		store: deps.store,
		audit: deps.audit,
		onActivated: deps.onActivated,
		flags: billingFlags(env),
		now: deps.now ?? Date.now,
		log: (message, detail) => console.warn(message, detail),
		baseUrl: deps.baseUrl
	};
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
	// the unsubscribe key is derived from the sign-in code secret, which every deployment already has
	const preferences: PreferenceServices = {
		getDb,
		audit: async (orgId, input) => {
			await append(await getDb(), orgId, input, heads);
		},
		now: Date.now,
		keySecret: text(env, 'AUTH_CODE_SECRET'),
		baseUrl
	};
	const planOf = async (orgId: string) => entitlementOf(await billing.getAccount(orgId));
	// counts and lease writes go through the engine, which holds the control key; the dashboard signs
	// each message type with its own secret, and an unset one resolves to the start secret
	const batch = {
		...engineBatchConfigOf(env),
		now: Date.now,
		newId: () => crypto.randomUUID()
	};
	const engineCounts = engineCountsReaders(batch);
	const budgetMode = (): BudgetMode => budgetModeOf(text(env, 'BUDGET_ENFORCEMENT'));
	const budgets: BudgetServices = {
		store: collegeBudgetStore(getDb),
		source: collegeBudgetSource(getDb, planOf),
		planOf,
		audit: async (orgId, input) => {
			await append(await getDb(), orgId, input, heads);
		},
		// shadow reads counts and writes nothing; `on` also needs the write secret
		enforcement: () => {
			const mode = budgetMode();
			if (!countsConfigured(batch) || (mode === 'on' && !budgetConfigured(batch)))
				return null;
			return {
				mode,
				now: Date.now,
				source: budgets.source,
				counts: engineCounts.views,
				authority: engineBudgetWriter(batch),
				ledger: collegeStateLedger(getDb, Date.now),
				audit: budgets.audit,
				// without the secret there is no unsubscribeUrl, and optional alerts are held
				alerts: budgetAlertSink({
					...(preferences.keySecret === undefined
						? {}
						: {
								unsubscribeUrl: (recipient, category) =>
									unsubscribeUrlFor(preferences, recipient, category)
							}),
					now: Date.now,
					log: (message, detail) => console.warn(message, detail),
					paused: async () => isPlatformFlagOn(await getDb(), 'notifications.paused'),
					record: async (category, status) =>
						recordMail(await getDb(), {
							category,
							class: isEssential(category) ? 'essential' : 'optional',
							status,
							at: Date.now()
						}),
					remaining: async () => {
						const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000;
						return DAILY_MAIL_CAP - (await countMailSentSince(await getDb(), dayStart));
					},
					...collegeAlertStore(getDb),
					recipients: async (orgId) => collegeRecipients(await getDb(), orgId),
					names: async (orgId, siteId) => collegeNames(await getDb(), orgId, siteId),
					budgetUrl: () => `${baseUrl}/billing`,
					send: (to, input) => contactMailOf(env, options).send(to, input),
					recordSent: async (category) =>
						recordMailSent(await getDb(), {
							category,
							class: isEssential(category) ? 'essential' : 'optional',
							at: Date.now()
						})
				}),
				log: (message, detail) => console.warn(message, detail)
			};
		},
		mode: budgetMode,
		overageBilled: () => billingFlags(env).overageEnabled,
		newId: () => `bg_${crypto.randomUUID()}`,
		now: Date.now
	};
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
			signupsPaused: async () => isPlatformFlagOn(await getDb(), 'signups.paused'),
			keys: collegeKeyIndex(getDb)
		},
		identity: {
			store: collegeIdentityStore(getDb),
			webauthn: webauthnConfig(env, baseUrl),
			clients: oauthClients(oauthConfig(env, baseUrl, options.oauthClientIds)),
			fetch: (input, init) => fetch(input, init)
		},
		sso: {
			store: collegeSsoStore(getDb),
			members: collegeSsoMembers(getDb),
			identities: collegeIdentityStore(getDb),
			directory: collegeDirectory(getDb, heads),
			kv: env.KV,
			once: collegeOnceStore(getDb),
			ring: async () => (await pendingSecrets()).ring,
			oidc: {
				fetch: (input, init) => fetch(input, init),
				resolve: (hostname) => dohResolve(hostname),
				once: collegeOnceStore(getDb),
				cache: createJwksCache(),
				now: Date.now
			},
			dns: dohResolver(),
			redirectUri: (slug) => `${baseUrl}/api/v1/auth/sso/${slug}/callback`,
			notify: securityMailOf(env, options, baseUrl),
			now: Date.now
		},
		organizations: { getDb },
		keys: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: () => nowUtc().toMillis()
		},
		members: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			inviteMail: inviteMailOf(env, options),
			baseUrl,
			now: Date.now
		},
		governance: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: Date.now,
			newId: () => crypto.randomUUID(),
			ownerFacts: async (orgId, userId) =>
				(
					await loadFacts(
						{
							store: collegeFactsStore(getDb),
							entitlements: async (id) => entitlementKeys(await planOf(id)),
							policy: async (input) => loadPolicyFor(await getDb(), input)
						},
						{
							principal: { kind: 'user', userId },
							scope: 'organization',
							action: 'key.create',
							params: { orgId }
						}
					)
				)?.facts ?? null,
			reviewMail: reviewMailer({
				recipients: async (orgId) => collegeReviewers(await getDb(), orgId),
				paused: async () => isPlatformFlagOn(await getDb(), 'notifications.paused'),
				record: async (category, status) =>
					recordMail(await getDb(), {
						category,
						class: isEssential(category) ? 'essential' : 'optional',
						status,
						at: Date.now()
					}),
				unsubscribeUrl: (reviewer, category) =>
					unsubscribeUrlFor(preferences, reviewer, category),
				send: (to, input) => contactMailOf(env, options).send(to, input),
				baseUrl
			})
		},
		departments: defaultDepartmentServices(getDb, (orgId, input) =>
			getDb().then((db) => append(db, orgId, input, heads))
		),
		policies: defaultPolicyServices(getDb, (orgId, input) =>
			getDb().then((db) => append(db, orgId, input, heads))
		),
		support: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			ownerEmails: collegeSsoMembers(getDb).ownerEmails,
			notify: securityMailOf(env, options, baseUrl),
			startOperation,
			newId: () => `sg_${crypto.randomUUID()}`,
			now: Date.now
		},
		delegations: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: Date.now
		},
		transfers: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: Date.now,
			targetLimits: async (orgId) => {
				const { sites } = await planOf(orgId);
				if (sites === null) {
					throw new ApiError(
						'not_built',
						'The site limit of the receiving plan is not known'
					);
				}
				return { siteLimit: sites };
			},
			startCompletion: startOperation
		},
		clients: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: Date.now,
			usage: usageReadsOf(getDb).samples
		},
		siteGrants: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: Date.now
		},
		api: {
			resolvePrincipal: createPrincipalResolver(),
			idempotency: collegeIdempotencyStore(getDb),
			load: factsLoader({
				entitlements: async (orgId) => entitlementKeys(await planOf(orgId)),
				budgets: collegeBudgets(getDb),
				policy: async (input) => loadPolicyFor(await getDb(), input),
				platform: platformStanding(getDb),
				support: supportStanding(getDb, platformStanding(getDb), Date.now),
				...options.facts,
				store: collegeFactsStore(getDb)
			}),
			access: (event) =>
				verifyAccessToken(
					accessTokenOf(event),
					accessConfigOf(text(env, 'ACCESS_TEAM'), text(env, 'ACCESS_AUD'))
				),
			// break-glass owners are told once when it starts, so a later use sends nothing
			notifyOwners: async () => undefined,
			...auditWriters(getDb, heads)
		},
		costCenters: {
			getDb,
			usage: usageReadsOf(getDb).reads,
			newId: () => crypto.randomUUID(),
			now: Date.now
		},
		usageViews: { getDb, now: Date.now, planOf },
		usageCollect: () =>
			countsConfigured(batch)
				? {
						now: Date.now,
						sites: productionSites(getDb),
						hours: engineCounts.hours,
						store: productionUsageStore(getDb)
					}
				: null,
		pilots: {
			getDb,
			usage: usageReadsOf(getDb).reads,
			newId: () => crypto.randomUUID(),
			now: Date.now
		},
		trust: {
			getDb,
			blobs: trustBlobsOf(env.BLOB),
			newId: () => crypto.randomUUID(),
			now: Date.now
		},
		procurement: { getDb, newId: () => crypto.randomUUID(), now: Date.now },
		contacts: {
			getDb,
			mail: contactMailOf(env, options),
			baseUrl,
			now: Date.now
		},
		preferences,
		ownerTokens,
		sites: siteServices,
		backups: backupServicesOf({ BLOB: env.BLOB }, { getDb, startOperation }, heads, {
			pagedRestore: text(env, 'PAGED_RESTORE') === 'on'
		}),
		access: {
			getDb,
			planOf,
			startOperation,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: Date.now
		},
		ladder: {
			getDb,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			now: Date.now
		},
		modules: {
			getDb,
			custody: async () => {
				const pending = await pendingSecrets();
				return { store: ownerTokens, audit: pending.audit, ring: pending.ring };
			},
			startOperation,
			planOf,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads))
		},
		modify: {
			getDb,
			startOperation,
			planOf,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads)),
			ownerTokens,
			blobs: r2BackupBlobs(env.BLOB)
		},
		customBundles: { getDb, planOf, blobs: r2BackupBlobs(env.BLOB), now: Date.now },
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
		siteSettings: {
			getDb,
			custody: async () => {
				const pending = await pendingSecrets();
				return { store: ownerTokens, audit: pending.audit, ring: pending.ring };
			},
			startOperation,
			audit: (orgId, input) => getDb().then((db) => append(db, orgId, input, heads))
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
		planeConnections: {
			getDb,
			ring: async () => (await pendingSecrets()).ring,
			fetch: (input, init) => fetch(input, init),
			now: Date.now,
			audit: async (orgId, action, targetId) => {
				await append(
					await getDb(),
					orgId,
					{ actor: 'dashboard', action, target: targetId },
					heads
				);
			}
		},
		releases: {
			getDb,
			once: collegeOnceStore(getDb),
			fetch: (input, init) => fetch(input, init),
			resolve: (hostname) => dohResolve(hostname),
			now: Date.now,
			hookSecret: text(env, 'NUXT_RELEASE_HOOK_SECRET') ?? (options.releaseHook?.secret || '')
		},
		domain: domainServicesOf({
			secrets: env as Record<string, string | undefined>,
			target: text(env, 'CUSTOM_HOSTNAME_TARGET')
		}),
		pendingSecrets,
		heads,
		billing: billingServicesOf(env, {
			store: billing,
			audit: async (orgId, input) => {
				await append(await getDb(), orgId, input, heads);
			},
			baseUrl,
			onActivated: async (orgId) => {
				await seedOrgBudgetFor(budgets, orgId);
			}
		}),
		budgets
	};
}

let booted: BuiltServices | null = null;

// installs the services once per isolate; a second call, whatever its env, changes nothing
export function bootOnce(env: BootEnv, options: BootOptions = {}): BuiltServices {
	if (booted) return booted;
	const built = buildServices(env, options);
	setAuthServices(built.auth);
	setIdentityServices(built.identity);
	setSsoServices(built.sso);
	setCostCenterServices(built.costCenters);
	setUsageServices(built.usageViews);
	setPilotServices(built.pilots);
	setTrustServices(built.trust);
	setProcurementServices(built.procurement);
	setContactServices(built.contacts);
	setPreferenceServices(built.preferences);
	setOrganizationServices(built.organizations);
	setKeyServices(built.keys);
	setMembersServices(built.members);
	setDepartmentServices(built.departments);
	setGovernanceServices(built.governance);
	setPolicyServices(built.policies);
	setSupportServices(built.support);
	setSiteGrantServices(built.siteGrants);
	setDelegationServices(built.delegations);
	setTransferServices(built.transfers);
	setClientServices(built.clients);
	setApiDeps(built.api);
	setSiteServices(built.sites);
	setBackupServices(built.backups);
	setAccessServices(built.access);
	setLadderServices(built.ladder);
	setModuleServices(built.modules);
	setModifyServices(built.modify);
	setCustomBundleServices(built.customBundles);
	setCutoverServices(built.cutover);
	setFleetServices(built.fleet);
	setImportServices(built.imports);
	setSiteHealthServices(built.siteHealth);
	setSiteSettingsServices(built.siteSettings);
	setCapacityServices(built.capacity);
	setRepoConnectionDeps(built.repoConnections);
	setPlaneConnectionDeps(built.planeConnections);
	setReleaseServices(built.releases);
	setDomainServices(built.domain);
	setEstateServices({ keys: built.domain.keys, dns: built.domain.resolver });
	setPendingSecretDeps(built.pendingSecrets);
	setBillingServices(built.billing);
	setBudgetServices(built.budgets);
	setUsageCollectFactory(built.usageCollect);
	booted = built;
	return built;
}

export const isBooted = (): boolean => booted !== null;

export function bootedServices(): BuiltServices {
	if (!booted) throw new ApiError('not_built', 'The services are not installed yet');
	return booted;
}

export function resetBoot(): void {
	booted = null;
	setAuthServices(null);
	setIdentityServices(null);
	setSsoServices(null);
	setCostCenterServices(null);
	setUsageServices(null);
	setUsageCollectFactory(null);
	setPilotServices(null);
	setTrustServices(null);
	setProcurementServices(null);
	setContactServices(null);
	setPreferenceServices(null);
	setOrganizationServices(null);
	setKeyServices(null);
	setMembersServices(null);
	setDepartmentServices(null);
	setGovernanceServices(null);
	setPolicyServices(null);
	setSupportServices(null);
	setSiteGrantServices(null);
	setDelegationServices(null);
	setTransferServices(null);
	setClientServices(null);
	resetApiDeps();
	resetSiteServices();
	resetBackupServices();
	resetAccessServices();
	setLadderServices(null);
	resetModuleServices();
	resetModifyServices();
	resetCustomBundleServices();
	resetCutoverServices();
	resetFleetServices();
	resetImportServices();
	resetSiteHealthServices();
	resetSiteSettingsServices();
	resetCapacityServices();
	setRepoConnectionDeps(null);
	setPlaneConnectionDeps(null);
	setReleaseServices(null);
	resetDomainServices();
	resetEstateServices();
	resetPendingSecretDeps();
	setBillingServices(null);
	setBudgetServices(null);
}

// #endregion
