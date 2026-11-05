import type { CollegeDBClient } from '@earth-app/collegedb';
import { isUniqueViolation } from '../db/collegedb';

// a unique collision means another writer took the seq; each rival wins at most once
const MAX_ATTEMPTS = 5;
const VERIFY_PAGE = 500;

export class AuditConflictError extends Error {
	readonly code = 'AUDIT_CONFLICT';

	constructor(organizationId: string) {
		super(`audit append for ${organizationId} lost ${MAX_ATTEMPTS} sequence races`);
		this.name = 'AuditConflictError';
	}
}

export interface AuditInput {
	actor: string;
	action: string;
	target: string;
	detail?: Record<string, unknown>;
}

export interface AuditEntry {
	organizationId: string;
	seq: number;
	prevHash: string;
	hash: string;
	actor: string;
	action: string;
	target: string;
	detailJson: string;
	createdAt: number;
}

interface EntryFields {
	organization_id: string;
	seq: number;
	actor: string;
	action: string;
	target: string;
	detail: string;
	created_at: number;
}

interface AuditRow extends EntryFields {
	prev_hash: string;
	hash: string;
}

export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>;
		const members = Object.keys(record)
			.sort()
			.filter((key) => record[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
		return `{${members.join(',')}}`;
	}
	return JSON.stringify(value);
}

export async function hashEntry(prevHash: string, fields: EntryFields): Promise<string> {
	const bytes = new TextEncoder().encode(prevHash + canonicalJson(fields));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fieldsOf(row: AuditRow): EntryFields {
	return {
		organization_id: row.organization_id,
		seq: row.seq,
		actor: row.actor,
		action: row.action,
		target: row.target,
		detail: row.detail,
		created_at: row.created_at
	};
}

export async function append(
	db: CollegeDBClient,
	organizationId: string,
	input: AuditInput
): Promise<AuditEntry> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const last = await db.first<{ seq: number; hash: string }>(
			organizationId,
			'SELECT seq, hash FROM audit_log WHERE organization_id = ? ORDER BY seq DESC LIMIT 1',
			[organizationId]
		);
		const fields: EntryFields = {
			organization_id: organizationId,
			seq: last ? last.seq + 1 : 0,
			actor: input.actor,
			action: input.action,
			target: input.target,
			detail: canonicalJson(input.detail ?? {}),
			created_at: Date.now()
		};
		const prevHash = last?.hash ?? '';
		const hash = await hashEntry(prevHash, fields);
		try {
			await db.run(
				organizationId,
				`INSERT INTO audit_log (organization_id, seq, prev_hash, hash, actor, action,
				 target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				[
					fields.organization_id,
					fields.seq,
					prevHash,
					hash,
					fields.actor,
					fields.action,
					fields.target,
					fields.detail,
					fields.created_at
				]
			);
		} catch (error) {
			if (isUniqueViolation(error)) continue;
			throw error;
		}
		return {
			organizationId,
			seq: fields.seq,
			prevHash,
			hash,
			actor: fields.actor,
			action: fields.action,
			target: fields.target,
			detailJson: fields.detail,
			createdAt: fields.created_at
		};
	}
	throw new AuditConflictError(organizationId);
}

export async function appendBoth(
	db: CollegeDBClient,
	organizationId: string,
	otherOrganizationId: string,
	input: AuditInput
): Promise<[AuditEntry, AuditEntry]> {
	const first = await append(db, organizationId, input);
	const second = await append(db, otherOrganizationId, input);
	return [first, second];
}

// first index that fails the position, link or hash check; null when intact
export async function verify(db: CollegeDBClient, organizationId: string): Promise<number | null> {
	let index = 0;
	let prevHash = '';
	let afterSeq = -1;
	for (;;) {
		const page = await db.all<AuditRow>(
			organizationId,
			`SELECT organization_id, seq, prev_hash, hash, actor, action, target, detail, created_at
			 FROM audit_log WHERE organization_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
			[organizationId, afterSeq, VERIFY_PAGE]
		);
		for (const row of page.results) {
			const intact =
				row.seq === index &&
				row.prev_hash === prevHash &&
				(await hashEntry(row.prev_hash, fieldsOf(row))) === row.hash;
			if (!intact) return index;
			prevHash = row.hash;
			index++;
		}
		const last = page.results.at(-1);
		if (page.results.length < VERIFY_PAGE || !last) return null;
		afterSeq = last.seq;
	}
}
