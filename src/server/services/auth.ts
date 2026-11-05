import type { CollegeDBClient } from '@earth-app/collegedb';
import { ApiError } from '../../shared/errors';
import { STEP_UP_WINDOW_MS } from '../../shared/permissions';
import { nowUtc } from '../../shared/utils/time';
import { DuplicateRowError } from '../db/collegedb';
import {
	createUser,
	getUserByEmail,
	getUserById,
	normalizeEmail,
	type User
} from '../db/repos/identity';
import { addMember, createOrganization, type Organization } from '../db/repos/organization';
import { append, type AuditInput } from './audit';
import { consumeCode, issueCode, type MailSender } from './email-codes';
import {
	createSession,
	rotateSession,
	type IssuedSession,
	type KvStore,
	type SessionRecord
} from './sessions';

// #region collaborators

export interface Directory {
	findUserByEmail(email: string): Promise<User | null>;
	findUserById(id: string): Promise<User | null>;
	createUser(email: string): Promise<User>;
	createPersonalOrganization(user: User): Promise<Organization>;
	appendAudit(organizationId: string, input: AuditInput): Promise<void>;
}

export type TurnstileCheck = (
	token: string | undefined,
	ip: string | undefined
) => Promise<boolean>;

export interface AuthDeps {
	kv: KvStore;
	directory: Directory;
	mail: MailSender;
	turnstile: TurnstileCheck;
	codeSecret: string;
}

// the h2 repositories behind the directory seam; the handle resolves on first use
export function collegeDirectory(getDb: () => Promise<CollegeDBClient>): Directory {
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
		async createPersonalOrganization(user) {
			const db = await getDb();
			const org = await createOrganization(db, {
				name: 'Personal',
				personal: true,
				createdBy: user.id
			});
			await addMember(db, org.id, { userId: user.id, role: 'owner' });
			return org;
		},
		async appendAudit(organizationId, input) {
			await append(await getDb(), organizationId, input);
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
		deps.kv,
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

// a unique-email collision means a parallel verify made the user first, so that one owns the setup
async function findOrCreateUser(
	directory: Directory,
	email: string
): Promise<{ user: User; isNew: boolean }> {
	const existing = await directory.findUserByEmail(email);
	if (existing) return { user: existing, isNew: false };
	try {
		const user = await directory.createUser(email);
		const org = await directory.createPersonalOrganization(user);
		await directory.appendAudit(org.id, {
			actor: user.id,
			action: 'account.create',
			target: user.id,
			detail: { method: 'email-code' }
		});
		return { user, isNew: true };
	} catch (error) {
		if (!(error instanceof DuplicateRowError)) throw error;
		const winner = await directory.findUserByEmail(email);
		if (!winner) throw error;
		return { user: winner, isNew: false };
	}
}

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
	if (!(await consumeCode(deps.kv, deps.codeSecret, email, input.code, nowUtc().toMillis()))) {
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
	if (!(await consumeCode(deps.kv, deps.codeSecret, user.email, input.code, now))) {
		throw invalidCode();
	}
	const issued = await rotateSession(deps.kv, input.userId, input.sessionId, { stepUpAt: now });
	if (!issued) throw new ApiError('unauthenticated', 'Authentication is required');
	return issued;
}

// #endregion
