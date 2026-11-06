import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import { STEP_UP_WINDOW_MS } from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { DuplicateRowError } from '../db/collegedb';
import { ensurePersonalOrganization } from '../db/repos/accounts';
import {
	createUser,
	getUserByEmail,
	getUserById,
	normalizeEmail,
	type User
} from '../db/repos/identity';
import type { Organization } from '../db/repos/organization';
import { append, type AuditInput, type HeadStore } from './audit';
import { sha256Hex } from './crypto';
import { consumeCode, issueCode, type AttemptStore, type MailSender } from './email-codes';
import {
	createSession,
	rotateSession,
	truncateIp,
	type IssuedSession,
	type KvStore,
	type SessionRecord
} from './sessions';
import type { OnceStore } from './single-use';

// #region collaborators

export interface Directory {
	findUserByEmail(email: string): Promise<User | null>;
	findUserById(id: string): Promise<User | null>;
	createUser(email: string): Promise<User>;
	// idempotent: the organisation and the owner membership come together or not at all
	ensurePersonalOrganization(user: User): Promise<{ org: Organization; created: boolean }>;
	appendAudit(organizationId: string, input: AuditInput): Promise<void>;
}

export type TurnstileCheck = (
	token: string | undefined,
	ip: string | undefined
) => Promise<boolean>;

export interface AuthDeps {
	kv: KvStore;
	once: OnceStore;
	attempts: AttemptStore;
	directory: Directory;
	mail: MailSender;
	turnstile: TurnstileCheck;
	codeSecret: string;
}

// the h2 repositories behind the directory seam; the handle resolves on first use
export function collegeDirectory(
	getDb: () => Promise<CollegeDBClient>,
	heads?: HeadStore
): Directory {
	return {
		async findUserByEmail(email) {
			return getUserByEmail(await getDb(), email);
		},
		async findUserById(id) {
			return getUserById(await getDb(), id);
		},
		async createUser(email) {
			return createUser(await getDb(), { email });
		},
		async ensurePersonalOrganization(user) {
			return ensurePersonalOrganization(await getDb(), user.id);
		},
		async appendAudit(organizationId, input) {
			await append(await getDb(), organizationId, input, heads);
		}
	};
}

// #endregion

// #region sign-in

const INVALID_CODE = 'The code is invalid or has expired';

const invalidCode = () => new ApiError('unauthenticated', INVALID_CODE);

function ready(deps: AuthDeps): void {
	if (deps.codeSecret === '') throw new ApiError('not_built', 'Sign-in codes are not configured');
}

export async function requestCode(
	deps: AuthDeps,
	input: { email: string; turnstileToken?: string; ip?: string }
): Promise<void> {
	ready(deps);
	if (!(await deps.turnstile(input.turnstileToken, input.ip))) {
		throw new ApiError('forbidden', 'The bot check failed', { requires: 'challenge' });
	}
	const result = await issueCode(
		deps.once,
		deps.mail,
		deps.codeSecret,
		input.email,
		nowUtc().toMillis()
	);
	if (!result.ok) {
		throw new ApiError('rate_limited', 'Too many codes requested for this address', {
			retryAfterSeconds: result.retryAfterSeconds
		});
	}
}

// the caller has already proven the address belongs to the person; null means a parallel sign-up
// made the user first and owns the setup
export async function createAccount(
	directory: Directory,
	email: string,
	method: string
): Promise<User | null> {
	try {
		const user = await directory.createUser(email);
		const { org } = await directory.ensurePersonalOrganization(user);
		await directory.appendAudit(org.id, {
			actor: user.id,
			action: 'account.create',
			target: user.id,
			detail: { method }
		});
		return user;
	} catch (error) {
		if (error instanceof DuplicateRowError) return null;
		throw error;
	}
}

// a user whose setup stopped halfway gets the missing organisation and membership on sign-in
export async function healAccount(directory: Directory, user: User): Promise<void> {
	const { org, created } = await directory.ensurePersonalOrganization(user);
	if (!created) return;
	await directory.appendAudit(org.id, {
		actor: user.id,
		action: 'account.repair',
		target: user.id,
		detail: { restored: 'personal-organization' }
	});
}

async function findOrCreateUser(
	directory: Directory,
	email: string
): Promise<{ user: User; isNew: boolean }> {
	const existing = await directory.findUserByEmail(email);
	if (existing) {
		await healAccount(directory, existing);
		return { user: existing, isNew: false };
	}
	const created = await createAccount(directory, email, 'email-code');
	if (created) return { user: created, isNew: true };
	const winner = await directory.findUserByEmail(email);
	if (!winner) throw new ApiError('internal', 'The account could not be created');
	return { user: winner, isNew: false };
}

// #endregion

// #region denial audit

// failed sign-ins go to one chain per address hash, so known and unknown addresses cost the same
export async function authChain(email: string): Promise<string> {
	return `auth:${await sha256Hex(normalizeEmail(email))}`;
}

// a failed write must not change the answer to the caller; it holds no code, token or address
async function auditDenied(
	deps: AuthDeps,
	input: { email: string; action: string; reason: string; ip?: string | null; actor?: string }
): Promise<void> {
	try {
		const chain = await authChain(input.email);
		await deps.directory.appendAudit(chain, {
			actor: input.actor ?? 'anonymous',
			action: input.action,
			target: chain,
			detail: { reason: input.reason, network: truncateIp(input.ip) }
		});
	} catch (error) {
		console.error('audit write failed', error);
	}
}

// #endregion

// #region verify

export interface SignedIn extends IssuedSession {
	user: User;
	isNew: boolean;
}

// a provider identity never reaches this path, so nothing here can merge accounts
export async function verifyCode(
	deps: AuthDeps,
	input: { email: string; code: string; userAgent?: string | null; ip?: string | null }
): Promise<SignedIn> {
	ready(deps);
	const email = normalizeEmail(input.email);
	const now = nowUtc().toMillis();
	if (!(await consumeCode(deps.once, deps.attempts, deps.codeSecret, email, input.code, now))) {
		await auditDenied(deps, {
			email,
			action: 'auth.code.denied',
			reason: 'invalid_code',
			ip: input.ip
		});
		throw invalidCode();
	}
	const { user, isNew } = await findOrCreateUser(deps.directory, email);
	const issued = await createSession(deps.kv, {
		userId: user.id,
		userAgent: input.userAgent,
		ip: input.ip
	});
	return { ...issued, user, isNew };
}

// #endregion

// #region step-up

export function stepUpUntil(session: Pick<SessionRecord, 'stepUpAt'>): number | null {
	return session.stepUpAt === undefined ? null : session.stepUpAt + STEP_UP_WINDOW_MS;
}

// a fresh code for the signed-in address proves a recent authentication; the session id rotates with it
export async function stepUp(
	deps: AuthDeps,
	input: { userId: string; sessionId: string; code: string }
): Promise<IssuedSession> {
	ready(deps);
	const user = await deps.directory.findUserById(input.userId);
	if (!user) throw new ApiError('unauthenticated', 'Authentication is required');
	const now = nowUtc().toMillis();
	if (
		!(await consumeCode(deps.once, deps.attempts, deps.codeSecret, user.email, input.code, now))
	) {
		await auditDenied(deps, {
			email: user.email,
			action: 'auth.step-up.denied',
			reason: 'invalid_code',
			actor: user.id
		});
		throw invalidCode();
	}
	const issued = await rotateSession(deps.kv, input.userId, input.sessionId, { stepUpAt: now });
	if (!issued) throw new ApiError('unauthenticated', 'Authentication is required');
	return issued;
}

// #endregion
