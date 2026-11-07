import type { AdminPasswordState } from '@contracts/sites';
import type { CollegeDBClient } from '@earth-app/collegedb';
import {
	CryptoError,
	decryptRecordText,
	encryptRecord,
	envelopeSchema,
	rewrap,
	type Envelope,
	type KeyRing
} from '../../shared/custody/envelope';
import {
	adminPasswordState,
	ownerTokenAad,
	pendingSecretAad,
	type PendingSecretKind
} from '../../shared/custody/records';
import { ApiError } from '../../shared/errors';
import { nowUtc } from '../../shared/utils/time';
import { getOwnerToken, putOwnerToken } from '../db/repos/owner-tokens';
import {
	getPendingSecret,
	markPendingSecretRevealed,
	replacePendingCiphertext,
	siteInOrganization,
	type PendingSecretRow
} from '../db/repos/pending-secrets';
import type { Principal } from '../domain/authorize';
import type { AuditInput } from './audit';
import { randomToken } from './crypto';

// the platform holds each site's owner token until the worker accepts signed assertions;
// previous is kept only while a rotation is in flight
export interface OwnerTokenRecord {
	current: Envelope;
	previous: Envelope | null;
}

export interface StoredOwnerToken extends OwnerTokenRecord {
	version: number;
}

export class OwnerTokenConflictError extends ApiError {
	constructor(siteId: string) {
		super('conflict', 'The owner token changed while this request ran', {
			reason: 'owner_token_conflict',
			siteId
		});
		this.name = 'OwnerTokenConflictError';
	}
}

// put writes only while the stored version is still `expected` (null: no record yet), returns the
// new version, and throws OwnerTokenConflictError when another writer got there first
export interface OwnerTokenStore {
	get(siteId: string): Promise<StoredOwnerToken | null>;
	put(siteId: string, value: OwnerTokenRecord, expected: number | null): Promise<number>;
}

export function collegeOwnerTokenStore(getDb: () => Promise<CollegeDBClient>): OwnerTokenStore {
	return {
		async get(siteId) {
			const row = await getOwnerToken(await getDb(), siteId);
			if (!row) return null;
			return {
				version: row.version,
				current: envelopeSchema.parse(JSON.parse(row.current)),
				previous: row.previous ? envelopeSchema.parse(JSON.parse(row.previous)) : null
			};
		},
		async put(siteId, value, expected) {
			const version = await putOwnerToken(
				await getDb(),
				siteId,
				{
					current: JSON.stringify(value.current),
					previous: value.previous ? JSON.stringify(value.previous) : null
				},
				expected,
				nowUtc().toMillis()
			);
			if (version === null) throw new OwnerTokenConflictError(siteId);
			return version;
		}
	};
}

export interface AuditSink {
	append(input: AuditInput): Promise<unknown>;
}

export interface CustodyDeps {
	store: OwnerTokenStore;
	audit: AuditSink;
	ring: KeyRing;
}

export interface SessionCall {
	siteId: string;
	principal: Principal;
	// set by the session layer from a fresh authentication within the step-up window
	stepUp: boolean;
}

export function principalActor(principal: Principal): string {
	return principal.kind === 'user' ? `user:${principal.userId}` : `key:${principal.keyId}`;
}

function requireSessionStepUp(call: SessionCall): void {
	if (call.principal.kind !== 'user') {
		throw new ApiError('forbidden', 'This action needs a signed-in session', {
			reason: 'session_only'
		});
	}
	if (!call.stepUp) {
		throw new ApiError('forbidden', 'This action needs a fresh sign-in', {
			reason: 'step_up_required'
		});
	}
}

async function load(deps: CustodyDeps, siteId: string): Promise<StoredOwnerToken> {
	const stored = await deps.store.get(siteId);
	if (!stored) throw new ApiError('not_found', 'No owner token is stored for this site');
	return stored;
}

// the audit row is written before the secret is touched, so a use that fails still leaves a trace
function record(
	deps: { audit: AuditSink },
	actor: string,
	action: string,
	siteId: string,
	detail: Record<string, unknown>
): Promise<unknown> {
	return deps.audit.append({ actor, action, target: siteId, detail });
}

export async function storeOwnerToken(
	deps: CustodyDeps,
	call: { siteId: string; actor: string; token: string }
): Promise<void> {
	await record(deps, call.actor, 'site.owner-token.store', call.siteId, {
		keyVersion: deps.ring.current
	});
	const current = await encryptRecord(call.token, ownerTokenAad(call.siteId), deps.ring);
	const existing = await deps.store.get(call.siteId);
	await deps.store.put(call.siteId, { current, previous: null }, existing?.version ?? null);
}

export async function revealOwnerToken(deps: CustodyDeps, call: SessionCall): Promise<string> {
	requireSessionStepUp(call);
	const stored = await load(deps, call.siteId);
	await record(deps, principalActor(call.principal), 'site.owner-token.reveal', call.siteId, {
		keyVersion: stored.current.kv
	});
	return decryptRecordText(stored.current, ownerTokenAad(call.siteId), deps.ring);
}

// the plaintext exists only inside fn; a platform worker call goes through here
export async function withOwnerToken<T>(
	deps: CustodyDeps,
	call: { siteId: string; actor: string; operation: string },
	fn: (token: string) => Promise<T>
): Promise<T> {
	const stored = await load(deps, call.siteId);
	await record(deps, call.actor, 'site.owner-token.use', call.siteId, {
		keyVersion: stored.current.kv,
		operation: call.operation
	});
	return fn(await decryptRecordText(stored.current, ownerTokenAad(call.siteId), deps.ring));
}

// push sets the new token on the site, authenticating with the old one. The old record stays in
// `previous` until push succeeds, and is restored if it throws. Every write names the version it
// read, so a second rotation of the same site fails before it can push or restore anything
export async function rotateOwnerToken(
	deps: CustodyDeps,
	call: SessionCall,
	push: (newToken: string, oldToken: string) => Promise<void>
): Promise<void> {
	requireSessionStepUp(call);
	const stored = await load(deps, call.siteId);
	const actor = principalActor(call.principal);
	const aad = ownerTokenAad(call.siteId);
	const oldToken = await decryptRecordText(stored.current, aad, deps.ring);
	await record(deps, actor, 'site.owner-token.rotate', call.siteId, {
		fromKeyVersion: stored.current.kv,
		keyVersion: deps.ring.current
	});
	const newToken = randomToken();
	const next = await encryptRecord(newToken, aad, deps.ring);
	let version: number;
	try {
		version = await deps.store.put(
			call.siteId,
			{ current: next, previous: stored.current },
			stored.version
		);
	} catch (error) {
		if (error instanceof OwnerTokenConflictError) {
			await record(deps, actor, 'site.owner-token.rotate-failed', call.siteId, {
				keyVersion: stored.current.kv,
				reason: 'conflict'
			});
		}
		throw error;
	}
	try {
		await push(newToken, oldToken);
	} catch (error) {
		try {
			await deps.store.put(call.siteId, { current: stored.current, previous: null }, version);
		} catch (restoreError) {
			// another writer moved the record since our write, so it is theirs to keep
			if (!(restoreError instanceof OwnerTokenConflictError)) throw restoreError;
		}
		await record(deps, actor, 'site.owner-token.rotate-failed', call.siteId, {
			keyVersion: stored.current.kv
		});
		throw error;
	}
	await deps.store.put(call.siteId, { current: next, previous: null }, version);
}

// moves both records to the newest key version; returns false when nothing needed moving
export async function rewrapOwnerToken(
	deps: CustodyDeps,
	call: { siteId: string; actor: string }
): Promise<boolean> {
	const stored = await load(deps, call.siteId);
	const current = await rewrap(stored.current, deps.ring);
	const previous = stored.previous ? await rewrap(stored.previous, deps.ring) : null;
	if (current.kv === stored.current.kv && (!previous || previous.kv === stored.previous?.kv)) {
		return false;
	}
	await record(deps, call.actor, 'site.owner-token.rewrap', call.siteId, {
		fromKeyVersion: stored.current.kv,
		keyVersion: deps.ring.current
	});
	await deps.store.put(call.siteId, { current, previous }, stored.version);
	return true;
}

// #region pending secrets

export interface PendingSecretStore {
	get(siteId: string, kind: PendingSecretKind): Promise<PendingSecretRow | null>;
	// true only for the one caller whose update found the secret unread and unexpired
	markRevealed(siteId: string, kind: PendingSecretKind, now: number): Promise<boolean>;
	// false when the row changed since it was read
	replaceCiphertext(
		siteId: string,
		kind: PendingSecretKind,
		change: { from: string; to: string; keyVersion: number }
	): Promise<boolean>;
	siteInOrganization(orgId: string, siteId: string): Promise<boolean>;
}

export function collegePendingSecretStore(
	getDb: () => Promise<CollegeDBClient>
): PendingSecretStore {
	return {
		async get(siteId, kind) {
			return getPendingSecret(await getDb(), siteId, kind);
		},
		async markRevealed(siteId, kind, now) {
			return markPendingSecretRevealed(await getDb(), siteId, kind, now);
		},
		async replaceCiphertext(siteId, kind, change) {
			return replacePendingCiphertext(await getDb(), siteId, kind, change);
		},
		async siteInOrganization(orgId, siteId) {
			return siteInOrganization(await getDb(), orgId, siteId);
		}
	};
}

export interface PendingSecretDeps {
	store: PendingSecretStore;
	audit: AuditSink;
	ring: KeyRing;
	now(): number;
}

export interface PendingSecretCall {
	orgId: string;
	siteId: string;
	kind: PendingSecretKind;
	principal: Principal;
}

const notFound = () => new ApiError('not_found', 'Not found');

// the secret leaves once: an unread, unexpired row of a site in this organisation, read and
// decrypted first, then handed out only to the caller whose conditional update wins
export async function revealPendingSecret(
	deps: PendingSecretDeps,
	call: PendingSecretCall
): Promise<string> {
	if (call.principal.kind !== 'user') {
		throw new ApiError('forbidden', 'This action needs a signed-in session', {
			reason: 'session_only'
		});
	}
	if (!(await deps.store.siteInOrganization(call.orgId, call.siteId))) throw notFound();
	const row = await deps.store.get(call.siteId, call.kind);
	if (!row || row.revealedAt !== null || row.expiresAt <= deps.now()) throw notFound();
	await record(deps, principalActor(call.principal), 'site.pending-secret.reveal', call.siteId, {
		kind: call.kind,
		keyVersion: row.keyVersion
	});
	let envelope: unknown;
	try {
		envelope = JSON.parse(row.ciphertext);
	} catch {
		throw new CryptoError('bad_record', 'the record is not a v1 envelope');
	}
	const value = await decryptRecordText(
		envelope,
		pendingSecretAad(call.siteId, call.kind),
		deps.ring
	);
	if (!(await deps.store.markRevealed(call.siteId, call.kind, deps.now()))) throw notFound();
	return value;
}

// the state of a site's first admin password without opening it; the caller has already checked
// that the site belongs to the organisation. No audit row: nothing secret is read
export async function adminPasswordStateOf(
	deps: Pick<PendingSecretDeps, 'store' | 'now'>,
	site: { id: string; adminName: string | null }
): Promise<AdminPasswordState> {
	const row = await deps.store.get(site.id, 'admin-password');
	return adminPasswordState(row, deps.now(), site.adminName !== null);
}

// moves an unread secret to the newest key version; false when nothing was left to move
export async function rewrapPendingSecret(
	deps: PendingSecretDeps,
	call: { siteId: string; kind: PendingSecretKind; actor: string }
): Promise<boolean> {
	const row = await deps.store.get(call.siteId, call.kind);
	if (!row || row.revealedAt !== null || row.expiresAt <= deps.now()) return false;
	let envelope: unknown;
	try {
		envelope = JSON.parse(row.ciphertext);
	} catch {
		throw new CryptoError('bad_record', 'the record is not a v1 envelope');
	}
	const moved = await rewrap(envelope, deps.ring);
	if (moved.kv === row.keyVersion) return false;
	await record(deps, call.actor, 'site.pending-secret.rewrap', call.siteId, {
		kind: call.kind,
		fromKeyVersion: row.keyVersion,
		keyVersion: moved.kv
	});
	return deps.store.replaceCiphertext(call.siteId, call.kind, {
		from: row.ciphertext,
		to: JSON.stringify(moved),
		keyVersion: moved.kv
	});
}

// no secret store is wired until boot installs one, and every reveal answers 501 until then
let installedPending: (() => Promise<PendingSecretDeps>) | null = null;

export function setPendingSecretDeps(load: () => Promise<PendingSecretDeps>): void {
	installedPending = load;
}

export function resetPendingSecretDeps(): void {
	installedPending = null;
}

export async function pendingSecretDeps(): Promise<PendingSecretDeps> {
	if (installedPending === null) {
		throw new ApiError('not_built', 'Secret custody is not available yet');
	}
	return installedPending();
}

// #endregion
