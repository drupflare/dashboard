import type { CollegeDBClient } from '@earth-app/collegedb';
import { DIRECTORY_KEY } from '../collegedb';

export interface PlatformAuditRecord {
	id: number;
	actor: string;
	action: string;
	target: string;
	detail: unknown;
	createdAt: number;
}

export const MAX_PLATFORM_AUDIT_PAGE = 200;

// admin writes have no organisation, so they land here instead of in a customer's audit chain
export async function appendPlatformAudit(
	db: CollegeDBClient,
	input: { actor: string; action: string; target: string; detail: unknown; now: number }
): Promise<void> {
	await db.run(
		DIRECTORY_KEY,
		`INSERT INTO platform_audit (actor, action, target, detail, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		[input.actor, input.action, input.target, JSON.stringify(input.detail), input.now]
	);
}

export async function listPlatformAudit(
	db: CollegeDBClient,
	limit = 100,
	before?: number
): Promise<PlatformAuditRecord[]> {
	const take = Math.min(Math.max(1, Math.trunc(limit)), MAX_PLATFORM_AUDIT_PAGE);
	const { results } = await db.all<{
		id: number;
		actor: string;
		action: string;
		target: string;
		detail: string;
		created_at: number;
	}>(
		DIRECTORY_KEY,
		`SELECT id, actor, action, target, detail, created_at FROM platform_audit
		 WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
		[before ?? null, before ?? null, take]
	);
	return results.map((row) => ({
		id: row.id,
		actor: row.actor,
		action: row.action,
		target: row.target,
		detail: JSON.parse(row.detail) as unknown,
		createdAt: row.created_at
	}));
}
