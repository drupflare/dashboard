import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY, uniqueOrDuplicate, wasChanged } from '../collegedb';

export interface User {
	id: string;
	email: string;
	displayName: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface Identity {
	id: string;
	userId: string;
	provider: string;
	providerSubject: string;
	email: string | null;
	verified: boolean;
	createdAt: number;
}

interface UserRow {
	id: string;
	email: string;
	display_name: string | null;
	created_at: number;
	updated_at: number;
}

interface IdentityRow {
	id: string;
	user_id: string;
	provider: string;
	provider_subject: string;
	email: string | null;
	verified: number;
	created_at: number;
}

const USER_COLUMNS = 'id, email, display_name, created_at, updated_at';
const IDENTITY_COLUMNS = 'id, user_id, provider, provider_subject, email, verified, created_at';

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

function toUser(row: UserRow): User {
	return {
		id: row.id,
		email: row.email,
		displayName: row.display_name,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

function toIdentity(row: IdentityRow): Identity {
	return {
		id: row.id,
		userId: row.user_id,
		provider: row.provider,
		providerSubject: row.provider_subject,
		email: row.email,
		verified: row.verified === 1,
		createdAt: row.created_at
	};
}

export async function createUser(
	db: CollegeDBClient,
	input: { email: string; displayName?: string | null }
): Promise<User> {
	const now = Date.now();
	const user: User = {
		id: crypto.randomUUID(),
		email: normalizeEmail(input.email),
		displayName: input.displayName ?? null,
		createdAt: now,
		updatedAt: now
	};
	await uniqueOrDuplicate(() =>
		db.run(DIRECTORY_KEY, `INSERT INTO users (${USER_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [
			user.id,
			user.email,
			user.displayName,
			user.createdAt,
			user.updatedAt
		])
	);
	return user;
}

export async function getUserById(db: CollegeDBClient, id: string): Promise<User | null> {
	const row = await db.first<UserRow>(
		DIRECTORY_KEY,
		`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
		[id]
	);
	return row ? toUser(row) : null;
}

export async function getUserByEmail(db: CollegeDBClient, email: string): Promise<User | null> {
	const row = await db.first<UserRow>(
		DIRECTORY_KEY,
		`SELECT ${USER_COLUMNS} FROM users WHERE email = ?`,
		[normalizeEmail(email)]
	);
	return row ? toUser(row) : null;
}

export async function createIdentity(
	db: CollegeDBClient,
	input: {
		userId: string;
		provider: string;
		providerSubject: string;
		email: string | null;
		verified: boolean;
	}
): Promise<Identity> {
	const identity: Identity = {
		id: crypto.randomUUID(),
		userId: input.userId,
		provider: input.provider,
		providerSubject: input.providerSubject,
		email: input.email,
		verified: input.verified,
		createdAt: Date.now()
	};
	await uniqueOrDuplicate(() =>
		db.run(
			DIRECTORY_KEY,
			`INSERT INTO identities (${IDENTITY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			[
				identity.id,
				identity.userId,
				identity.provider,
				identity.providerSubject,
				identity.email,
				identity.verified ? 1 : 0,
				identity.createdAt
			]
		)
	);
	return identity;
}

export async function getIdentityByProviderSubject(
	db: CollegeDBClient,
	provider: string,
	providerSubject: string
): Promise<Identity | null> {
	const row = await db.first<IdentityRow>(
		DIRECTORY_KEY,
		`SELECT ${IDENTITY_COLUMNS} FROM identities WHERE provider = ? AND provider_subject = ?`,
		[provider, providerSubject]
	);
	return row ? toIdentity(row) : null;
}

export async function setIdentityVerified(
	db: CollegeDBClient,
	id: string,
	verified: boolean
): Promise<boolean> {
	const result = await db.run(DIRECTORY_KEY, 'UPDATE identities SET verified = ? WHERE id = ?', [
		verified ? 1 : 0,
		id
	]);
	return wasChanged(result);
}
