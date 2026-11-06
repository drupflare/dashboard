import { sha256Hex } from '@contracts/common';
import type { CollegeDBClient } from '@earth-app/collegedb';
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
import { getPersonalOrganizationId } from '../db/repos/accounts';
import {
	advancePasskeyCounterRow,
	deleteIdentity,
	deletePasskeyRow,
	getPasskeyById,
	insertPasskeyRow,
	listIdentitiesByUser,
	listPasskeysByUser,
	renamePasskeyRow
} from '../db/repos/credentials';
import {
	createIdentity,
	getIdentityByProviderSubject,
	normalizeEmail,
	type Identity,
	type User
} from '../db/repos/identity';
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
import { createAccount, healAccount, type Directory } from './auth';
import { randomToken } from './crypto';
import { createSession, type IssuedSession, type KvStore } from './sessions';
import type { OnceStore } from './single-use';

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

// every row sits on the directory shard, so the unique pairs hold across shards
export function collegeIdentityStore(getDb: () => Promise<CollegeDBClient>): IdentityStore {
	return {
		async findIdentity(provider, subject) {
			return getIdentityByProviderSubject(await getDb(), provider, subject);
		},
		async listIdentities(userId) {
			return listIdentitiesByUser(await getDb(), userId);
		},
		async createIdentity(input) {
			return createIdentity(await getDb(), input);
		},
		async deleteIdentity(userId, id) {
			return deleteIdentity(await getDb(), userId, id);
		},
		async personalOrganizationId(userId) {
			return getPersonalOrganizationId(await getDb(), userId);
		},
		async listPasskeys(userId) {
			return listPasskeysByUser(await getDb(), userId);
		},
		async getPasskey(id) {
			return getPasskeyById(await getDb(), id);
		},
		async insertPasskey(passkey) {
			await insertPasskeyRow(await getDb(), passkey);
		},
		async advancePasskeyCounter(id, from, to, usedAt) {
			return advancePasskeyCounterRow(await getDb(), id, from, to, usedAt);
		},
		async renamePasskey(userId, id, name) {
			return renamePasskeyRow(await getDb(), userId, id, name);
		},
		async deletePasskey(userId, id) {
			return deletePasskeyRow(await getDb(), userId, id);
		}
	};
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
	once: OnceStore;
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
	const { kv, once, directory } = authServices();
	return { ...identityServices(), kv, once, directory };
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

const linkKey = (hash: string) => `link:pending:${hash}`;

const pendingSchema = z.object({
	provider: z.enum(OAUTH_PROVIDERS),
	subject: z.string(),
	email: z.string(),
	createdAt: z.number()
});

type Pending = z.infer<typeof pendingSchema>;

async function putPending(once: OnceStore, pending: Omit<Pending, 'createdAt'>): Promise<string> {
	const token = randomToken();
	const now = nowUtc().toMillis();
	const record: Pending = { ...pending, createdAt: now };
	await once.put(linkKey(await sha256Hex(token)), JSON.stringify(record), now + LINK_TTL_MS);
	return token;
}

function parsePending(raw: string | null): Pending | null {
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

async function readPending(once: OnceStore, token: string): Promise<Pending | null> {
	return parsePending(await once.get(linkKey(await sha256Hex(token)), nowUtc().toMillis()));
}

// the atomic delete decides which of several parallel confirmations may go on
async function takePending(once: OnceStore, token: string): Promise<Pending | null> {
	return parsePending(await once.take(linkKey(await sha256Hex(token)), nowUtc().toMillis()));
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

// a provider may start an account only on an address it has verified, and never on one that
// already has an account; null means a rival got there first
async function createProviderAccount(
	deps: IdentityDeps,
	provider: OAuthProvider,
	profile: ProviderProfile,
	email: string
): Promise<User | null> {
	if (!profile.emailVerified) throw unverifiedEmail();
	const user = await createAccount(deps.directory, email, provider);
	if (user === null) return null;
	try {
		await deps.store.createIdentity({
			userId: user.id,
			provider,
			providerSubject: profile.subject,
			email,
			verified: true
		});
	} catch (error) {
		if (error instanceof DuplicateRowError) return null;
		throw error;
	}
	return user;
}

const unverifiedEmail = () =>
	new ApiError('forbidden', 'The provider has not verified an email address', {
		requires: 'verified-email'
	});

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
		await healAccount(deps.directory, user);
		return signedIn(deps, user, false, context);
	}
	if (profile.email === null || !profile.emailVerified) throw unverifiedEmail();
	const email = normalizeEmail(profile.email);
	const needsLink = async (): Promise<ProviderSignIn> => ({
		status: 'link_required',
		provider,
		email,
		token: await putPending(deps.once, { provider, subject: profile.subject, email })
	});
	if (await deps.directory.findUserByEmail(email)) return needsLink();
	const created = await createProviderAccount(deps, provider, profile, email);
	return created ? signedIn(deps, created, true, context) : needsLink();
}

// #endregion

// #region link and unlink

export async function confirmLink(
	deps: IdentityDeps,
	input: { userId: string; stepUpAt: number | undefined; token: string | undefined }
): Promise<Identity> {
	requireFresh(input.stepUpAt);
	const token = input.token;
	const peeked = token ? await readPending(deps.once, token) : null;
	if (!token || !peeked) throw new ApiError('not_found', 'No sign-in is waiting to be linked');
	const user = await deps.directory.findUserById(input.userId);
	if (!user) throw new ApiError('unauthenticated', 'Authentication is required');
	if (normalizeEmail(user.email) !== peeked.email) {
		throw new ApiError('forbidden', 'This provider sign-in belongs to a different account');
	}
	const orgId = await auditOrg(deps, user.id);
	const pending = await takePending(deps.once, token);
	if (!pending) throw new ApiError('not_found', 'No sign-in is waiting to be linked');
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
		{ once: deps.once, store: deps.store, config: deps.webauthn },
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
		{ once: deps.once, store: deps.store, config: deps.webauthn },
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
		{ once: deps.once, store: deps.store, config: deps.webauthn },
		response
	);
	const user = await deps.directory.findUserById(passkey.userId);
	if (!user) throw new ApiError('unauthenticated', 'The passkey could not be verified');
	return signedIn(deps, user, false, context);
}

// #endregion
