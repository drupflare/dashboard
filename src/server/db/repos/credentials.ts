import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY, uniqueOrDuplicate, wasChanged } from '../collegedb';
import type { Identity } from './identity';

export interface PasskeyRow {
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

interface IdentityRow {
	id: string;
	user_id: string;
	provider: string;
	provider_subject: string;
	email: string | null;
	verified: number;
	created_at: number;
}

interface Row {
	id: string;
	user_id: string;
	public_key: string;
	counter: number;
	transports: string;
	device_type: 'singleDevice' | 'multiDevice';
	backed_up: number;
	name: string;
	created_at: number;
	last_used_at: number | null;
}

const PASSKEY_COLUMNS =
	'id, user_id, public_key, counter, transports, device_type, backed_up, name, created_at, last_used_at';

function parseTransports(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
	} catch {
		return [];
	}
}

function toPasskey(row: Row): PasskeyRow {
	return {
		id: row.id,
		userId: row.user_id,
		publicKey: row.public_key,
		counter: row.counter,
		transports: parseTransports(row.transports),
		deviceType: row.device_type,
		backedUp: row.backed_up === 1,
		name: row.name,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at
	};
}

// #region identities

export async function listIdentitiesByUser(
	db: CollegeDBClient,
	userId: string
): Promise<Identity[]> {
	const { results } = await db.all<IdentityRow>(
		DIRECTORY_KEY,
		`SELECT id, user_id, provider, provider_subject, email, verified, created_at
		 FROM identities WHERE user_id = ? ORDER BY created_at, id`,
		[userId]
	);
	return results.map((row) => ({
		id: row.id,
		userId: row.user_id,
		provider: row.provider,
		providerSubject: row.provider_subject,
		email: row.email,
		verified: row.verified === 1,
		createdAt: row.created_at
	}));
}

// the user id is part of the match, so one person cannot remove another's identity by id
export async function deleteIdentity(
	db: CollegeDBClient,
	userId: string,
	id: string
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		'DELETE FROM identities WHERE id = ? AND user_id = ?',
		[id, userId]
	);
	return wasChanged(result);
}

// #endregion

// #region passkeys

export async function listPasskeysByUser(
	db: CollegeDBClient,
	userId: string
): Promise<PasskeyRow[]> {
	const { results } = await db.all<Row>(
		DIRECTORY_KEY,
		`SELECT ${PASSKEY_COLUMNS} FROM passkeys WHERE user_id = ? ORDER BY created_at, id`,
		[userId]
	);
	return results.map(toPasskey);
}

export async function getPasskeyById(db: CollegeDBClient, id: string): Promise<PasskeyRow | null> {
	const row = await db.first<Row>(
		DIRECTORY_KEY,
		`SELECT ${PASSKEY_COLUMNS} FROM passkeys WHERE id = ?`,
		[id]
	);
	return row ? toPasskey(row) : null;
}

export async function insertPasskeyRow(db: CollegeDBClient, passkey: PasskeyRow): Promise<void> {
	await uniqueOrDuplicate(() =>
		db.run(
			DIRECTORY_KEY,
			`INSERT INTO passkeys (${PASSKEY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				passkey.id,
				passkey.userId,
				passkey.publicKey,
				passkey.counter,
				JSON.stringify(passkey.transports),
				passkey.deviceType,
				passkey.backedUp ? 1 : 0,
				passkey.name,
				passkey.createdAt,
				passkey.lastUsedAt
			]
		)
	);
}

// compare and set: the row moves only while it still holds the counter the caller verified against
export async function advancePasskeyCounterRow(
	db: CollegeDBClient,
	id: string,
	from: number,
	to: number,
	usedAt: number
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ? AND counter = ?',
		[to, usedAt, id, from]
	);
	return wasChanged(result);
}

export async function renamePasskeyRow(
	db: CollegeDBClient,
	userId: string,
	id: string,
	name: string
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		'UPDATE passkeys SET name = ? WHERE id = ? AND user_id = ?',
		[name, id, userId]
	);
	return wasChanged(result);
}

export async function deletePasskeyRow(
	db: CollegeDBClient,
	userId: string,
	id: string
): Promise<boolean> {
	const result = await db.run(
		DIRECTORY_KEY,
		'DELETE FROM passkeys WHERE id = ? AND user_id = ?',
		[id, userId]
	);
	return wasChanged(result);
}

// #endregion
