import { canonicalJson, sha256Hex, utf8 } from '@contracts/common';
import { z } from 'zod';
import { SINGLE_RESTORE_BYTES } from '../../src/shared/restore-limits';
import { PermanentError } from './step';

// the worker's own default for MAX_RESTORE_BYTES; a dump above it goes through the paged restore
export const DEFAULT_RESTORE_CEILING_BYTES = SINGLE_RESTORE_BYTES;

// unreviewed: a dump that needs more pages than this is stopped instead of filling the bucket
export const MAX_EXPORT_PAGES = 1024;

export const BACKUP_ERROR_CODES = [
	'bad_key',
	'no_owner_token',
	'site_not_ready',
	'export_unreadable',
	'export_not_replayable',
	'export_stalled',
	'export_too_long',
	'part_missing',
	'part_changed',
	'manifest_invalid',
	'manifest_changed',
	'backup_not_found',
	'not_restorable',
	'target_not_ready',
	'target_other_organisation',
	'owner_token_rejected',
	'restore_too_large',
	'restore_rejected',
	'restore_unsupported',
	'restore_busy',
	'restore_unaligned',
	'restore_stalled',
	'files_copy_failed',
	'files_unsupported',
	'files_too_many',
	'import_failed',
	'import_timeout',
	'adopting_timeout',
	'grant_refused',
	'grant_no_namespace'
] as const;
export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number];

// every message is fixed text built from ids and counts, so nothing thrown can quote a dump or a token
export class BackupError extends PermanentError {
	declare readonly code: BackupErrorCode;

	constructor(code: BackupErrorCode, message: string) {
		super(code, message);
	}
}

// #region layout

const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;
export const backupIdPattern = /^bkp_[0-9a-z]{8,40}$/;

function segment(value: string): string {
	if (!SEGMENT.test(value)) throw new BackupError('bad_key', 'a backup key part is not an id');
	return value;
}

export const backupKeys = {
	prefix: (orgId: string, siteId: string, backupId: string) =>
		`backups/${segment(orgId)}/${segment(siteId)}/${segment(backupId)}/`,
	part: (orgId: string, siteId: string, backupId: string, seq: number) =>
		`${backupKeys.prefix(orgId, siteId, backupId)}part-${String(seq).padStart(5, '0')}.sql`,
	manifest: (orgId: string, siteId: string, backupId: string) =>
		`${backupKeys.prefix(orgId, siteId, backupId)}manifest.json`
};

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function newBackupId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(26));
	let body = '';
	for (const byte of bytes) body += ID_ALPHABET[byte & 31];
	return `bkp_${body}`;
}

// #endregion

// #region the dump pages

export interface ExportPage {
	sql: string;
	nextCursor: string | null;
}

const pageSchema = z.looseObject({
	sql: z.string(),
	nextCursor: z.string().min(1).nullable()
});

// the parser's own error text can quote the body, so it is dropped
export function parseExportPage(text: string): ExportPage {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BackupError('export_unreadable', 'an export page was not readable');
	}
	const page = pageSchema.safeParse(parsed);
	if (!page.success)
		throw new BackupError('export_unreadable', 'an export page was not readable');
	return { sql: page.data.sql, nextCursor: page.data.nextCursor };
}

// #endregion

// #region the manifest

export const manifestSchema = z.strictObject({
	v: z.literal(1),
	id: z.string().regex(backupIdPattern),
	orgId: z.string().regex(SEGMENT),
	siteId: z.string().regex(SEGMENT),
	bytes: z.int().nonnegative(),
	parts: z.array(
		z.strictObject({
			seq: z.int().nonnegative(),
			bytes: z.int().nonnegative(),
			sha256: z.string().regex(/^[0-9a-f]{64}$/)
		})
	)
});
export type BackupManifest = z.infer<typeof manifestSchema>;
export type PartDescriptor = BackupManifest['parts'][number];

export function buildManifest(input: {
	id: string;
	orgId: string;
	siteId: string;
	parts: readonly PartDescriptor[];
}): BackupManifest {
	return manifestSchema.parse({
		v: 1,
		id: input.id,
		orgId: input.orgId,
		siteId: input.siteId,
		bytes: input.parts.reduce((sum, part) => sum + part.bytes, 0),
		parts: input.parts.map(({ seq, bytes, sha256 }) => ({ seq, bytes, sha256 }))
	});
}

export function parseManifest(text: string): BackupManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new BackupError('manifest_invalid', 'the manifest is not readable');
	}
	const manifest = manifestSchema.safeParse(parsed);
	if (!manifest.success) throw new BackupError('manifest_invalid', 'the manifest is not valid');
	const { parts } = manifest.data;
	const ordered = parts.every((part, index) => part.seq === index);
	const total = parts.reduce((sum, part) => sum + part.bytes, 0);
	if (!ordered || total !== manifest.data.bytes) {
		throw new BackupError('manifest_invalid', 'the manifest parts do not add up');
	}
	return manifest.data;
}

// the row keeps this, so a manifest swapped in the bucket no longer matches its record
export function manifestDigest(manifest: BackupManifest): Promise<string> {
	return sha256Hex(canonicalJson(manifest));
}

// #endregion

// #region checking and joining

export const restorable = (bytes: number, ceiling: number) => bytes <= ceiling;

export async function describePart(seq: number, bytes: Uint8Array): Promise<PartDescriptor> {
	return { seq, bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
}

export async function checkPart(part: PartDescriptor, bytes: Uint8Array | null): Promise<void> {
	if (bytes === null) {
		throw new BackupError('part_missing', `part ${part.seq} is missing from the bucket`);
	}
	if (bytes.byteLength !== part.bytes || (await sha256Hex(bytes)) !== part.sha256) {
		throw new BackupError('part_changed', `part ${part.seq} does not match the manifest`);
	}
}

export function joinParts(parts: readonly Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.byteLength;
	}
	return out;
}

export const partBytes = (sql: string) => utf8(sql);

// #endregion

// #region table text

export const BACKUP_COLUMNS = `id, site_id, organization_id, operation_id, bytes, sha256, parts, restorable,
	verified, label, created_at, deleted_at`;

export interface BackupRecord {
	id: string;
	siteId: string;
	organizationId: string;
	operationId: string;
	bytes: number;
	sha256: string;
	parts: number;
	restorable: boolean;
	verified: boolean;
	label: string | null;
	createdAt: number;
	deletedAt: number | null;
}

export interface BackupRow {
	id: string;
	site_id: string;
	organization_id: string;
	operation_id: string;
	bytes: number;
	sha256: string;
	parts: number;
	restorable: number;
	verified: number;
	label: string | null;
	created_at: number;
	deleted_at: number | null;
}

export function toBackupRecord(row: BackupRow): BackupRecord {
	return {
		id: row.id,
		siteId: row.site_id,
		organizationId: row.organization_id,
		operationId: row.operation_id,
		bytes: row.bytes,
		sha256: row.sha256,
		parts: row.parts,
		restorable: row.restorable === 1,
		verified: row.verified === 1,
		label: row.label,
		createdAt: row.created_at,
		deletedAt: row.deleted_at
	};
}

// #endregion
