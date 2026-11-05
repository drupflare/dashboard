import { ApiError } from '../../shared/errors';
import type { Principal } from '../domain/authorize';
import type { AuditInput } from './audit';
import {
	decryptRecordText,
	encryptRecord,
	randomToken,
	rewrap,
	type Aad,
	type Envelope,
	type KeyRing
} from './crypto';

const PURPOSE = 'owner-token';

// the platform holds each site's owner token until the worker accepts signed assertions;
// previous is kept only while a rotation is in flight
export interface StoredOwnerToken {
	current: Envelope;
	previous: Envelope | null;
}

export interface OwnerTokenStore {
	get(siteId: string): Promise<StoredOwnerToken | null>;
	put(siteId: string, value: StoredOwnerToken): Promise<void>;
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

function aadFor(siteId: string): Aad {
	return { siteId, purpose: PURPOSE };
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
	deps: CustodyDeps,
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
	const current = await encryptRecord(call.token, aadFor(call.siteId), deps.ring);
	await deps.store.put(call.siteId, { current, previous: null });
}

export async function revealOwnerToken(deps: CustodyDeps, call: SessionCall): Promise<string> {
	requireSessionStepUp(call);
	const stored = await load(deps, call.siteId);
	await record(deps, principalActor(call.principal), 'site.owner-token.reveal', call.siteId, {
		keyVersion: stored.current.kv
	});
	return decryptRecordText(stored.current, aadFor(call.siteId), deps.ring);
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
	return fn(await decryptRecordText(stored.current, aadFor(call.siteId), deps.ring));
}

// push sets the new token on the site, authenticating with the old one. The old record stays in
// `previous` until push succeeds, and is restored if it throws
export async function rotateOwnerToken(
	deps: CustodyDeps,
	call: SessionCall,
	push: (newToken: string, oldToken: string) => Promise<void>
): Promise<void> {
	requireSessionStepUp(call);
	const stored = await load(deps, call.siteId);
	const actor = principalActor(call.principal);
	const aad = aadFor(call.siteId);
	const oldToken = await decryptRecordText(stored.current, aad, deps.ring);
	await record(deps, actor, 'site.owner-token.rotate', call.siteId, {
		fromKeyVersion: stored.current.kv,
		keyVersion: deps.ring.current
	});
	const newToken = randomToken();
	const next = await encryptRecord(newToken, aad, deps.ring);
	await deps.store.put(call.siteId, { current: next, previous: stored.current });
	try {
		await push(newToken, oldToken);
	} catch (error) {
		await deps.store.put(call.siteId, { current: stored.current, previous: null });
		await record(deps, actor, 'site.owner-token.rotate-failed', call.siteId, {
			keyVersion: stored.current.kv
		});
		throw error;
	}
	await deps.store.put(call.siteId, { current: next, previous: null });
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
	await deps.store.put(call.siteId, { current, previous });
	return true;
}
