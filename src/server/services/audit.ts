import type { R2Bucket } from '@cloudflare/workers-types';
import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
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

export class AuditHeadConflictError extends Error {
	readonly code = 'AUDIT_HEAD_CONFLICT';

	constructor(organizationId: string) {
		super(`audit head for ${organizationId} lost ${MAX_ATTEMPTS} write races`);
		this.name = 'AuditHeadConflictError';
	}
}

// #region head store

// the newest hash and the chain length, kept outside the database that holds the rows, so
// deleting the newest rows there leaves a record that they existed
export interface ChainHead {
	length: number;
	hash: string;
}

export interface StoredHead extends ChainHead {
	version: string;
}

// put writes only while the stored version is still `expected` (null: no head yet) and returns
// false when another writer moved the head first
export interface HeadStore {
	get(organizationId: string): Promise<StoredHead | null>;
	put(organizationId: string, head: ChainHead, expected: string | null): Promise<boolean>;
}

const headSchema = z.object({ length: z.int().positive(), hash: z.string().min(1) });

const headKey = (organizationId: string) => `audit-head/${organizationId}.json`;

export function r2HeadStore(bucket: R2Bucket): HeadStore {
	return {
		async get(organizationId) {
			const object = await bucket.get(headKey(organizationId));
			if (!object) return null;
			const head = headSchema.parse(JSON.parse(await object.text()));
			return { ...head, version: object.etag };
		},
		async put(organizationId, head, expected) {
			const onlyIf =
				expected === null ? { etagDoesNotMatch: '*' } : { etagMatches: expected };
			const written = await bucket.put(headKey(organizationId), JSON.stringify(head), {
				onlyIf
			});
			return written !== null;
		}
	};
}

// the head only moves forward, so a slow writer never undoes a newer one
async function advanceHead(
	heads: HeadStore,
	organizationId: string,
	head: ChainHead
): Promise<void> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const current = await heads.get(organizationId);
		if (current && current.length >= head.length) return;
		if (await heads.put(organizationId, head, current?.version ?? null)) return;
	}
	throw new AuditHeadConflictError(organizationId);
}

// #endregion

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

const INSERT_ROW = `INSERT INTO audit_log (organization_id, seq, prev_hash, hash, actor, action,
	 target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// the next row of a chain, built from the newest row now stored
async function nextEntry(
	db: CollegeDBClient,
	organizationId: string,
	input: AuditInput
): Promise<{ entry: AuditEntry; bindings: unknown[] }> {
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
	return {
		entry: {
			organizationId,
			seq: fields.seq,
			prevHash,
			hash,
			actor: fields.actor,
			action: fields.action,
			target: fields.target,
			detailJson: fields.detail,
			createdAt: fields.created_at
		},
		bindings: [
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
	};
}

// with a head store the new head is recorded after the row is written, so the head is never ahead
// of the chain; a failed head write throws and the caller sees the append as failed
export async function append(
	db: CollegeDBClient,
	organizationId: string,
	input: AuditInput,
	heads?: HeadStore
): Promise<AuditEntry> {
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const { entry, bindings } = await nextEntry(db, organizationId, input);
		try {
			await db.run(organizationId, INSERT_ROW, bindings);
		} catch (error) {
			if (isUniqueViolation(error)) continue;
			throw error;
		}
		if (heads) await advanceHead(heads, organizationId, headOf(entry));
		return entry;
	}
	throw new AuditConflictError(organizationId);
}

const headOf = (entry: AuditEntry): ChainHead => ({ length: entry.seq + 1, hash: entry.hash });

// both rows go in one batch, which D1 runs as one transaction per database. Organisations on
// different databases are two transactions, so a seq race on one retries only that row
export async function appendBoth(
	db: CollegeDBClient,
	organizationId: string,
	otherOrganizationId: string,
	input: AuditInput,
	heads?: HeadStore
): Promise<[AuditEntry, AuditEntry]> {
	if (organizationId === otherOrganizationId) {
		const first = await append(db, organizationId, input, heads);
		return [first, await append(db, organizationId, input, heads)];
	}
	const orgs = [organizationId, otherOrganizationId];
	const done: (AuditEntry | undefined)[] = [undefined, undefined];
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const todo = [0, 1].filter((slot) => done[slot] === undefined);
		if (todo.length === 0) break;
		const rows = await Promise.all(todo.map((slot) => nextEntry(db, orgs[slot]!, input)));
		const groups = await db.batch(
			rows.map((row, index) => ({
				key: orgs[todo[index]!]!,
				sql: INSERT_ROW,
				bindings: row.bindings
			}))
		);
		for (const group of groups) {
			if (group.error !== undefined) {
				if (isUniqueViolation(new Error(group.error))) continue;
				throw new Error(group.error);
			}
			for (const index of group.indices) done[todo[index]!] = rows[index]!.entry;
		}
	}
	const [first, second] = done;
	if (!first || !second)
		throw new AuditConflictError(first ? otherOrganizationId : organizationId);
	if (heads) {
		await advanceHead(heads, organizationId, headOf(first));
		await advanceHead(heads, otherOrganizationId, headOf(second));
	}
	return [first, second];
}

// first index that fails the position, link or hash check; null when intact. With a head store the
// chain must also reach the recorded head and hold its hash at that position. It may run past the
// head, since a head write can trail the row it records. The head is read before the rows are
export async function verify(
	db: CollegeDBClient,
	organizationId: string,
	heads?: HeadStore
): Promise<number | null> {
	const head = heads ? await heads.get(organizationId) : null;
	let index = 0;
	let prevHash = '';
	let afterSeq = -1;
	let hashAtHead: string | null = null;
	const finish = (): number | null => {
		if (!head) return null;
		if (index < head.length) return index;
		return hashAtHead === head.hash ? null : head.length - 1;
	};
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
			if (head && index === head.length - 1) hashAtHead = row.hash;
			prevHash = row.hash;
			index++;
		}
		const last = page.results.at(-1);
		if (page.results.length < VERIFY_PAGE || !last) return finish();
		afterSeq = last.seq;
	}
}
