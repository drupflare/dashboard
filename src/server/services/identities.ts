import { sha256Hex } from '@contracts/common';
import type {
	AuthenticationResponseJSON,
	PublicKeyCredentialCreationOptionsJSON,
	RegistrationResponseJSON
} from '@simplewebauthn/server';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { STEP_UP_WINDOW_MS } from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { DuplicateRowError } from '../db/collegedb';
import { normalizeEmail, type Identity, type User } from '../db/repos/identity';
import {
	OAUTH_PROVIDERS,
	type FetchLike,
	type OAuthClients,
	type OAuthProvider,
	type ProviderProfile
} from '../integrations/oauth';
import {
	cleanPasskeyName,
	registrationOptions,
	verifyAuthentication,
	verifyRegistration,
	type PasskeyRecord,
	type PasskeyStore,
	type WebAuthnConfig
} from '../integrations/webauthn';
import { authServices } from '../utils/auth';
import type { Directory } from './auth';
import { randomToken } from './crypto';
import { createSession, type IssuedSession, type KvStore } from './sessions';

// #region collaborators

export interface IdentityStore extends PasskeyStore {
	findIdentity(provider: string, subject: string): Promise<Identity | null>;
	listIdentities(userId: string): Promise<Identity[]>;
	createIdentity(input: {
		userId: string;
		provider: string;
		providerSubject: string;
		email: string | null;
		verified: boolean;
	}): Promise<Identity>;
	deleteIdentity(userId: string, id: string): Promise<boolean>;
	personalOrganizationId(userId: string): Promise<string | null>;
}

export interface IdentityServices {
	store: IdentityStore;
	webauthn: WebAuthnConfig;
	clients: OAuthClients;
	fetch: FetchLike;
	// the email code is a permanent sign-in method, so it counts toward the last-method rule
	emailFloor?: boolean;
}

export interface IdentityDeps extends IdentityServices {
	kv: KvStore;
	directory: Directory;
}

let installed: IdentityServices | null = null;

export function setIdentityServices(services: IdentityServices | null): void {
	installed = services;
}

export function identityServices(): IdentityServices {
	if (installed === null) throw new ApiError('not_built', 'Sign-in is not available yet');
	return installed;
}

export function identityDeps(): IdentityDeps {
	const { kv, directory } = authServices();
	return { ...identityServices(), kv, directory };
}

// #endregion

// #region guards

export function requireFresh(stepUpAt: number | undefined): void {
	const age = stepUpAt === undefined ? -1 : nowUtc().toMillis() - stepUpAt;
	if (age < 0 || age > STEP_UP_WINDOW_MS) {
		throw new ApiError('forbidden', 'Fresh authentication is required', {
			requires: 'step-up'
		});
	}
}

async function auditOrg(deps: IdentityDeps, userId: string): Promise<string> {
	const orgId = await deps.store.personalOrganizationId(userId);
	if (orgId === null) throw new ApiError('internal', 'The account has no audit trail');
	return orgId;
}

async function signInMethodCount(deps: IdentityDeps, userId: string): Promise<number> {
	const [identities, passkeys] = await Promise.all([
		deps.store.listIdentities(userId),
		deps.store.listPasskeys(userId)
	]);
	return (deps.emailFloor === false ? 0 : 1) + identities.length + passkeys.length;
}

const lastMethod = () =>
	new ApiError('conflict', 'This is your last sign-in method, so it cannot be removed');

// #endregion

// #region pending link

export const LINK_COOKIE = '__Host-drupflare_link';
export const LINK_TTL_MS = 15 * 60 * 1000;

const KV_MIN_TTL_SECONDS = 60;

const linkKey = (hash: string) => `link:pending:${hash}`;

const pendingSchema = z.object({
	provider: z.enum(OAUTH_PROVIDERS),
	subject: z.string(),
	email: z.string(),
	createdAt: z.number()
});

type Pending = z.infer<typeof pendingSchema>;

async function putPending(kv: KvStore, pending: Omit<Pending, 'createdAt'>): Promise<string> {
	const token = randomToken();
	const record: Pending = { ...pending, createdAt: nowUtc().toMillis() };
	await kv.put(linkKey(await sha256Hex(token)), JSON.stringify(record), {
		expirationTtl: Math.max(KV_MIN_TTL_SECONDS, LINK_TTL_MS / 1000)
	});
	return token;
}

async function readPending(kv: KvStore, token: string): Promise<Pending | null> {
	const raw = await kv.get(linkKey(await sha256Hex(token)));
	if (raw === null) return null;
	try {
		const parsed = pendingSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return null;
		const age = nowUtc().toMillis() - parsed.data.createdAt;
		return age >= 0 && age < LINK_TTL_MS ? parsed.data : null;
	} catch {
		return null;
	}
}

// #endregion

// #region provider sign-in

export type SignedInResult = { status: 'signed_in'; user: User; isNew: boolean } & IssuedSession;

export type ProviderSignIn =
	| SignedInResult
	| { status: 'link_required'; provider: OAuthProvider; email: string; token: string };

interface Context {
	userAgent?: string | null;
	ip?: string | null;
}

async function signedIn(
	deps: IdentityDeps,
	user: User,
	isNew: boolean,
	context: Context
): Promise<SignedInResult> {
	const issued = await createSession(deps.kv, {
		userId: user.id,
		userAgent: context.userAgent,
		ip: context.ip
	});
	return { status: 'signed_in', user, isNew, ...issued };
}

// the same steps as an email sign-up: user, personal organisation, owner membership, audit row
async function createAccount(
	deps: IdentityDeps,
	provider: OAuthProvider,
	profile: ProviderProfile,
	email: string
): Promise<User | null> {
	try {
		const user = await deps.directory.createUser(email);
		const org = await deps.directory.createPersonalOrganization(user);
		await deps.store.createIdentity({
			userId: user.id,
			provider,
			providerSubject: profile.subject,
			email,
			verified: true
		});
		await deps.directory.appendAudit(org.id, {
			actor: user.id,
			action: 'account.create',
			target: user.id,
			detail: { method: provider }
		});
		return user;
	} catch (error) {
		if (error instanceof DuplicateRowError) return null;
		throw error;
	}
}

// a provider identity never joins an account on its own: a matching email asks for a confirmed link
export async function signInWithProvider(
	deps: IdentityDeps,
	provider: OAuthProvider,
	profile: ProviderProfile,
	context: Context = {}
): Promise<ProviderSignIn> {
	const known = await deps.store.findIdentity(provider, profile.subject);
	if (known) {
		const user = await deps.directory.findUserById(known.userId);
		if (!user) throw new ApiError('unauthenticated', 'The sign-in could not be completed');
		return signedIn(deps, user, false, context);
	}
	if (profile.email === null || !profile.emailVerified) {
		throw new ApiError('forbidden', 'The provider has not verified an email address', {
			requires: 'verified-email'
		});
	}
	const email = normalizeEmail(profile.email);
	const needsLink = async (): Promise<ProviderSignIn> => ({
		status: 'link_required',
		provider,
		email,
		token: await putPending(deps.kv, { provider, subject: profile.subject, email })
	});
	if (await deps.directory.findUserByEmail(email)) return needsLink();
	const created = await createAccount(deps, provider, profile, email);
	return created ? signedIn(deps, created, true, context) : needsLink();
}

// #endregion

// #region link and unlink

export async function confirmLink(
	deps: IdentityDeps,
	input: { userId: string; stepUpAt: number | undefined; token: string | undefined }
): Promise<Identity> {
	requireFresh(input.stepUpAt);
	const pending = input.token ? await readPending(deps.kv, input.token) : null;
	if (!pending) throw new ApiError('not_found', 'No sign-in is waiting to be linked');
	const user = await deps.directory.findUserById(input.userId);
	if (!user) throw new ApiError('unauthenticated', 'Authentication is required');
	if (normalizeEmail(user.email) !== pending.email) {
		throw new ApiError('forbidden', 'This provider sign-in belongs to a different account');
	}
	const orgId = await auditOrg(deps, user.id);
	let identity: Identity;
	try {
		identity = await deps.store.createIdentity({
			userId: user.id,
			provider: pending.provider,
			providerSubject: pending.subject,
			email: pending.email,
			verified: true
		});
	} catch (error) {
		if (error instanceof DuplicateRowError) {
			throw new ApiError('conflict', 'This provider account is already linked');
		}
		throw error;
	}
	await deps.kv.delete(linkKey(await sha256Hex(input.token as string)));
	await deps.directory.appendAudit(orgId, {
		actor: user.id,
		action: 'account.identity.link',
		target: identity.id,
		detail: { provider: identity.provider }
	});
	return identity;
}

export async function unlinkIdentity(
	deps: IdentityDeps,
	input: { userId: string; identityId: string; stepUpAt: number | undefined }
): Promise<void> {
	requireFresh(input.stepUpAt);
	const identities = await deps.store.listIdentities(input.userId);
	const identity = identities.find((entry) => entry.id === input.identityId);
	if (!identity) throw new ApiError('not_found', 'Not found');
	if ((await signInMethodCount(deps, input.userId)) <= 1) throw lastMethod();
	const orgId = await auditOrg(deps, input.userId);
	if (!(await deps.store.deleteIdentity(input.userId, identity.id))) {
		throw new ApiError('not_found', 'Not found');
	}
	await deps.directory.appendAudit(orgId, {
		actor: input.userId,
		action: 'account.identity.unlink',
		target: identity.id,
		detail: { provider: identity.provider }
	});
}

export function listIdentities(deps: IdentityDeps, userId: string): Promise<Identity[]> {
	return deps.store.listIdentities(userId);
}

// #endregion

// #region passkeys

export function listPasskeys(deps: IdentityDeps, userId: string): Promise<PasskeyRecord[]> {
	return deps.store.listPasskeys(userId);
}

export async function startPasskeyRegistration(
	deps: IdentityDeps,
	input: { userId: string; stepUpAt: number | undefined }
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	requireFresh(input.stepUpAt);
	const user = await deps.directory.findUserById(input.userId);
	if (!user) throw new ApiError('unauthenticated', 'Authentication is required');
	return registrationOptions(
		{ kv: deps.kv, store: deps.store, config: deps.webauthn },
		{ id: user.id, email: user.email }
	);
}

export async function finishPasskeyRegistration(
	deps: IdentityDeps,
	input: {
		userId: string;
		stepUpAt: number | undefined;
		response: RegistrationResponseJSON;
		name?: string;
	}
): Promise<PasskeyRecord> {
	requireFresh(input.stepUpAt);
	const orgId = await auditOrg(deps, input.userId);
	const passkey = await verifyRegistration(
		{ kv: deps.kv, store: deps.store, config: deps.webauthn },
		{ id: input.userId },
		input.response,
		input.name
	);
	await deps.directory.appendAudit(orgId, {
		actor: input.userId,
		action: 'account.passkey.add',
		target: passkey.id
	});
	return passkey;
}

export async function renamePasskey(
	deps: IdentityDeps,
	input: { userId: string; passkeyId: string; name: string }
): Promise<void> {
	const orgId = await auditOrg(deps, input.userId);
	const name = cleanPasskeyName(input.name);
	if (!(await deps.store.renamePasskey(input.userId, input.passkeyId, name))) {
		throw new ApiError('not_found', 'Not found');
	}
	await deps.directory.appendAudit(orgId, {
		actor: input.userId,
		action: 'account.passkey.rename',
		target: input.passkeyId
	});
}

export async function removePasskey(
	deps: IdentityDeps,
	input: { userId: string; passkeyId: string; stepUpAt: number | undefined }
): Promise<void> {
	requireFresh(input.stepUpAt);
	const passkeys = await deps.store.listPasskeys(input.userId);
	if (!passkeys.some((passkey) => passkey.id === input.passkeyId)) {
		throw new ApiError('not_found', 'Not found');
	}
	if ((await signInMethodCount(deps, input.userId)) <= 1) throw lastMethod();
	const orgId = await auditOrg(deps, input.userId);
	if (!(await deps.store.deletePasskey(input.userId, input.passkeyId))) {
		throw new ApiError('not_found', 'Not found');
	}
	await deps.directory.appendAudit(orgId, {
		actor: input.userId,
		action: 'account.passkey.remove',
		target: input.passkeyId
	});
}

export async function signInWithPasskey(
	deps: IdentityDeps,
	response: AuthenticationResponseJSON,
	context: Context = {}
): Promise<SignedInResult> {
	const passkey = await verifyAuthentication(
		{ kv: deps.kv, store: deps.store, config: deps.webauthn },
		response
	);
	const user = await deps.directory.findUserById(passkey.userId);
	if (!user) throw new ApiError('unauthenticated', 'The passkey could not be verified');
	return signedIn(deps, user, false, context);
}

// #endregion
