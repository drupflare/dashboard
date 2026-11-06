import type { CollegeDBClient } from '@earth-app/collegedb';
import { getMember, getOrganization, type Organization } from './organization';

// a person's own organisation has an id made from the user id, so finding it needs no index; the
// letters and digits of the id keep it inside the contract's org id format
export const personalOrganizationId = (userId: string) =>
	`org_${userId.toLowerCase().replace(/[^0-9a-z]/g, '')}`;

const memberId = (userId: string) => `owner-${userId}`;

export class BatchFailedError extends Error {
	readonly code = 'BATCH_FAILED';

	constructor(shard: string, message: string) {
		super(`batch failed on ${shard}: ${message}`);
		this.name = 'BatchFailedError';
	}
}

// the organisation row and the owner membership share a key, so one batch holds both. Both inserts
// ignore a row that exists, so a retry and a parallel sign-in change nothing
export async function ensurePersonalOrganization(
	db: CollegeDBClient,
	userId: string
): Promise<{ org: Organization; created: boolean }> {
	const id = personalOrganizationId(userId);
	const member = await getMember(db, id, userId);
	const existing = member ? await getOrganization(db, id) : null;
	if (existing) return { org: existing, created: false };
	const now = Date.now();
	const groups = await db.batch([
		{
			key: id,
			sql: `INSERT OR IGNORE INTO organizations (id, name, personal, created_by, created_at,
			 updated_at) VALUES (?, 'Personal', 1, ?, ?, ?)`,
			bindings: [id, userId, now, now]
		},
		{
			key: id,
			sql: `INSERT OR IGNORE INTO members (id, organization_id, user_id, role, created_at,
			 updated_at) VALUES (?, ?, ?, 'owner', ?, ?)`,
			bindings: [memberId(userId), id, userId, now, now]
		}
	]);
	for (const group of groups) {
		if (group.error !== undefined) throw new BatchFailedError(group.shard, group.error);
	}
	const org = await getOrganization(db, id);
	if (!org) throw new BatchFailedError('unknown', 'the organisation is missing after the batch');
	// only the caller whose insert wrote the row reports it, so a parallel sign-in repairs once
	const inserted = groups.flatMap((group) => group.results)[0];
	return { org, created: (inserted?.meta?.changes ?? 0) > 0 };
}

export async function getPersonalOrganizationId(
	db: CollegeDBClient,
	userId: string
): Promise<string | null> {
	const id = personalOrganizationId(userId);
	return (await getMember(db, id, userId)) ? id : null;
}
