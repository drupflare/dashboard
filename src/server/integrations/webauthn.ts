import { fromBase64Url, sha256Hex, toBase64Url } from '@contracts/common';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { DuplicateRowError } from '../db/collegedb';
import type { KvStore } from '../services/sessions';

// #region types

export interface WebAuthnConfig {
	rpId: string;
	rpName: string;
	origin: string;
}

export interface PasskeyRecord {
	id: string;
	userId: string;
	publicKey: string;
	counter: number;
	transports: string[];
	deviceType: 'singleDevice' | 'multiDevice';
	backedUp: boolean;
	name: string;
	createdAt: number;
	lastUsedAt: number | null;
}

// the counter advance is a compare and set, so two replays of one assertion cannot both win
export interface PasskeyStore {
	listPasskeys(userId: string): Promise<PasskeyRecord[]>;
	getPasskey(id: string): Promise<PasskeyRecord | null>;
	insertPasskey(passkey: PasskeyRecord): Promise<void>;
	advancePasskeyCounter(id: string, from: number, to: number, usedAt: number): Promise<boolean>;
	renamePasskey(userId: string, id: string, name: string): Promise<boolean>;
	deletePasskey(userId: string, id: string): Promise<boolean>;
}

export interface WebAuthnDeps {
	kv: KvStore;
	store: PasskeyStore;
	config: WebAuthnConfig;
}

// #endregion

// #region wire schemas

const b64 = z.string().min(1).max(8192);

export const registrationResponseSchema = z.object({
	id: b64,
	rawId: b64,
	type: z.literal('public-key'),
	authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
	clientExtensionResults: z.record(z.string(), z.unknown()),
	response: z.object({
		clientDataJSON: b64,
		attestationObject: b64,
		transports: z.array(z.string().max(32)).max(8).optional()
	})
});

export const authenticationResponseSchema = z.object({
	id: b64,
	rawId: b64,
	type: z.literal('public-key'),
	authenticatorAttachment: z.enum(['platform', 'cross-platform']).optional(),
	clientExtensionResults: z.record(z.string(), z.unknown()),
	response: z.object({
		clientDataJSON: b64,
		authenticatorData: b64,
		signature: b64,
		userHandle: b64.optional()
	})
});

export const PASSKEY_NAME_MAX = 64;
const DEFAULT_NAME = 'Passkey';

// #endregion

// #region challenges

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const KV_MIN_TTL_SECONDS = 60;

const regKey = (userId: string) => `webauthn:reg:${userId}`;
const authKey = (hash: string) => `webauthn:auth:${hash}`;

const challengeSchema = z.object({ challenge: z.string(), createdAt: z.number() });

async function putChallenge(kv: KvStore, key: string, challenge: string): Promise<void> {
	const record = { challenge, createdAt: nowUtc().toMillis() };
	await kv.put(key, JSON.stringify(record), {
		expirationTtl: Math.max(KV_MIN_TTL_SECONDS, CHALLENGE_TTL_MS / 1000)
	});
}

// the record goes before it is checked, so a challenge works for one attempt only
async function takeChallenge(kv: KvStore, key: string): Promise<string | null> {
	const raw = await kv.get(key);
	if (raw === null) return null;
	await kv.delete(key);
	try {
		const parsed = challengeSchema.safeParse(JSON.parse(raw));
		if (!parsed.success) return null;
		const age = nowUtc().toMillis() - parsed.data.createdAt;
		return age >= 0 && age < CHALLENGE_TTL_MS ? parsed.data.challenge : null;
	} catch {
		return null;
	}
}

// #endregion

// #region registration

const utf8 = (text: string) => new TextEncoder().encode(text);

export function cleanPasskeyName(name: string | undefined): string {
	const trimmed = (name ?? '').replace(/\s+/g, ' ').trim().slice(0, PASSKEY_NAME_MAX);
	return trimmed === '' ? DEFAULT_NAME : trimmed;
}

export async function registrationOptions(
	deps: WebAuthnDeps,
	user: { id: string; email: string }
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	const existing = await deps.store.listPasskeys(user.id);
	const options = await generateRegistrationOptions({
		rpName: deps.config.rpName,
		rpID: deps.config.rpId,
		userName: user.email,
		userDisplayName: user.email,
		userID: utf8(user.id),
		attestationType: 'none',
		excludeCredentials: existing.map((passkey) => ({
			id: passkey.id,
			transports: passkey.transports
		})),
		authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
	});
	await putChallenge(deps.kv, regKey(user.id), options.challenge);
	return options;
}

const registrationFailed = () => new ApiError('validation', 'The passkey could not be verified');

export async function verifyRegistration(
	deps: WebAuthnDeps,
	user: { id: string },
	response: RegistrationResponseJSON,
	name: string | undefined
): Promise<PasskeyRecord> {
	const challenge = await takeChallenge(deps.kv, regKey(user.id));
	if (challenge === null) throw registrationFailed();
	let verified;
	try {
		verified = await verifyRegistrationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: deps.config.origin,
			expectedRPID: deps.config.rpId,
			requireUserPresence: true,
			requireUserVerification: true
		});
	} catch {
		throw registrationFailed();
	}
	if (!verified.verified) throw registrationFailed();
	const { credential, credentialDeviceType, credentialBackedUp } = verified.registrationInfo;
	const passkey: PasskeyRecord = {
		id: credential.id,
		userId: user.id,
		publicKey: toBase64Url(credential.publicKey),
		counter: credential.counter,
		transports: credential.transports ?? [],
		deviceType: credentialDeviceType,
		backedUp: credentialBackedUp,
		name: cleanPasskeyName(name),
		createdAt: nowUtc().toMillis(),
		lastUsedAt: null
	};
	if ((await deps.store.getPasskey(passkey.id)) !== null) throw alreadyRegistered();
	try {
		await deps.store.insertPasskey(passkey);
	} catch (error) {
		if (error instanceof DuplicateRowError) throw alreadyRegistered();
		throw error;
	}
	return passkey;
}

const alreadyRegistered = () => new ApiError('conflict', 'This passkey is already registered');

// #endregion

// #region authentication

export async function authenticationOptions(
	deps: Pick<WebAuthnDeps, 'kv' | 'config'>
): Promise<PublicKeyCredentialRequestOptionsJSON> {
	const options = await generateAuthenticationOptions({
		rpID: deps.config.rpId,
		userVerification: 'required'
	});
	await putChallenge(deps.kv, authKey(await sha256Hex(options.challenge)), options.challenge);
	return options;
}

// every failure reads the same, so the reply never says which check refused the passkey
const authFailed = () => new ApiError('unauthenticated', 'The passkey could not be verified');

export async function verifyAuthentication(
	deps: WebAuthnDeps,
	response: AuthenticationResponseJSON
): Promise<PasskeyRecord> {
	const passkey = await deps.store.getPasskey(response.id);
	if (passkey === null) throw authFailed();
	const handle = response.response.userHandle;
	if (handle !== undefined && handle !== toBase64Url(utf8(passkey.userId))) throw authFailed();
	let result;
	try {
		result = await verifyAuthenticationResponse({
			response,
			expectedChallenge: async (challenge) =>
				(await takeChallenge(deps.kv, authKey(await sha256Hex(challenge)))) === challenge,
			expectedOrigin: deps.config.origin,
			expectedRPID: deps.config.rpId,
			requireUserVerification: true,
			credential: {
				id: passkey.id,
				publicKey: fromBase64Url(passkey.publicKey),
				counter: passkey.counter,
				transports: passkey.transports
			}
		});
	} catch {
		throw authFailed();
	}
	if (!result.verified) throw authFailed();
	const now = nowUtc().toMillis();
	const advanced = await deps.store.advancePasskeyCounter(
		passkey.id,
		passkey.counter,
		result.authenticationInfo.newCounter,
		now
	);
	if (!advanced) throw authFailed();
	return { ...passkey, counter: result.authenticationInfo.newCounter, lastUsedAt: now };
}

// #endregion

// #region option schemas

// nothing parses these; they document the shapes the library returns
const descriptor = z.object({
	id: z.string(),
	type: z.string(),
	transports: z.array(z.string()).optional()
});

export const requestOptionsSchema = z.object({
	challenge: z.string(),
	timeout: z.number().optional(),
	rpId: z.string().optional(),
	allowCredentials: z.array(descriptor).optional(),
	userVerification: z.enum(['required', 'preferred', 'discouraged']).optional()
});

export const creationOptionsSchema = z.object({
	rp: z.object({ name: z.string(), id: z.string().optional() }),
	user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }),
	challenge: z.string(),
	pubKeyCredParams: z.array(z.object({ type: z.string(), alg: z.number() })),
	timeout: z.number().optional(),
	excludeCredentials: z.array(descriptor).optional(),
	authenticatorSelection: z
		.object({
			residentKey: z.enum(['discouraged', 'preferred', 'required']).optional(),
			userVerification: z.enum(['required', 'preferred', 'discouraged']).optional()
		})
		.optional(),
	attestation: z.enum(['none', 'indirect', 'direct', 'enterprise']).optional()
});

// #endregion
