import type { CollegeDBClient } from '@earth-app/collegedb';
import type { ContactRole } from '../../../shared/contacts';
import { wasChanged } from '../collegedb';

export interface ContactRow {
	id: string;
	organizationId: string;
	role: ContactRole;
	name: string;
	email: string;
	verifiedAt: number | null;
	notifyOn: boolean;
	createdAt: number;
	updatedAt: number;
}

interface ContactDb {
	id: string;
	organization_id: string;
	role: ContactRole;
	name: string;
	email: string;
	verified_at: number | null;
	notify_on: number;
	created_at: number;
	updated_at: number;
}

const COLUMNS =
	'id, organization_id, role, name, email, verified_at, notify_on, created_at, updated_at';

function toRow(row: ContactDb): ContactRow {
	return {
		id: row.id,
		organizationId: row.organization_id,
		role: row.role,
		name: row.name,
		email: row.email,
		verifiedAt: row.verified_at,
		notifyOn: row.notify_on === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at
	};
}

export async function listContacts(
	db: CollegeDBClient,
	organizationId: string
): Promise<ContactRow[]> {
	const { results } = await db.all<ContactDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM org_contacts WHERE organization_id = ? ORDER BY role`,
		[organizationId]
	);
	return results.map(toRow);
}

export async function getContact(
	db: CollegeDBClient,
	organizationId: string,
	role: ContactRole
): Promise<ContactRow | null> {
	const row = await db.first<ContactDb>(
		organizationId,
		`SELECT ${COLUMNS} FROM org_contacts WHERE organization_id = ? AND role = ?`,
		[organizationId, role]
	);
	return row ? toRow(row) : null;
}

// one contact per role; the caller decides the verified state, since a new address starts unverified
export async function upsertContact(db: CollegeDBClient, row: ContactRow): Promise<void> {
	await db.run(
		row.organizationId,
		`INSERT INTO org_contacts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (organization_id, role) DO UPDATE SET name = excluded.name,
		 email = excluded.email, verified_at = excluded.verified_at,
		 notify_on = excluded.notify_on, updated_at = excluded.updated_at`,
		[
			row.id,
			row.organizationId,
			row.role,
			row.name,
			row.email,
			row.verifiedAt,
			row.notifyOn ? 1 : 0,
			row.createdAt,
			row.updatedAt
		]
	);
}

// the contact's own opt-in switch; only an existing row changes
export async function setContactNotify(
	db: CollegeDBClient,
	input: { organizationId: string; role: ContactRole; notifyOn: boolean; at: number }
): Promise<boolean> {
	return wasChanged(
		await db.run(
			input.organizationId,
			`UPDATE org_contacts SET notify_on = ?, updated_at = ? WHERE organization_id = ? AND role = ?`,
			[input.notifyOn ? 1 : 0, input.at, input.organizationId, input.role]
		)
	);
}

// matches the address too, so a token sent to an old address cannot verify a changed one
export async function markContactVerified(
	db: CollegeDBClient,
	input: { organizationId: string; role: ContactRole; email: string; at: number }
): Promise<boolean> {
	return wasChanged(
		await db.run(
			input.organizationId,
			`UPDATE org_contacts SET verified_at = ?, updated_at = ?
			 WHERE organization_id = ? AND role = ? AND email = ?`,
			[input.at, input.at, input.organizationId, input.role, input.email]
		)
	);
}
