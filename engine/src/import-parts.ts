import type { Dossier } from '../../src/server/domain/dossier';
import type { BackupBlobs } from './ports';
import { PermanentError } from './step';

export const IMPORT_ERROR_CODES = [
	'bad_key',
	'dossier_refused',
	'unsupported_kind',
	'credential_missing',
	'credential_expired',
	'host_key_unconfirmed',
	'dump_empty',
	'dump_failed',
	'part_missing',
	'restore_too_large',
	'files_too_large',
	'files_landing_unavailable',
	'import_failed',
	'import_timeout'
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

// every message is fixed text built from ids and counts, so nothing thrown can quote a dump, a
// server answer or a key
export class ImportError extends PermanentError {
	declare readonly code: ImportErrorCode;

	constructor(code: ImportErrorCode, message: string) {
		super(code, message);
	}
}

// 8 MiB is the window the conversion readings used
export const PART_BYTES = 8 * 1024 * 1024;

// unreviewed: a dump written by mysqldump runs close to the size of the data, and twice that is
// a stop for a runaway stream, not a measurement
export const DUMP_LIMIT_FACTOR = 2;

// unreviewed: the most a files archive may carry before the stream stops
export const FILES_LIMIT_BYTES = 1024 * 1024 * 1024;

// #region layout

const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;

function segment(value: string): string {
	if (!SEGMENT.test(value)) throw new ImportError('bad_key', 'an import key part is not an id');
	return value;
}

export const partKey = (prefix: string, seq: number, ext: string) =>
	`${prefix}part-${String(seq).padStart(5, '0')}.${ext}`;
const part = partKey;

export const importKeys = {
	prefix: (orgId: string, operationId: string) =>
		`imports/${segment(orgId)}/${segment(operationId)}/`,
	dumpPrefix: (orgId: string, operationId: string) =>
		`${importKeys.prefix(orgId, operationId)}dump/`,
	filesPrefix: (orgId: string, operationId: string) =>
		`${importKeys.prefix(orgId, operationId)}files/`,
	sqlPrefix: (orgId: string, operationId: string) =>
		`${importKeys.prefix(orgId, operationId)}sql/`,
	dump: (orgId: string, operationId: string, seq: number) =>
		part(importKeys.dumpPrefix(orgId, operationId), seq, 'sql'),
	files: (orgId: string, operationId: string, seq: number) =>
		part(importKeys.filesPrefix(orgId, operationId), seq, 'tar'),
	sql: (orgId: string, operationId: string, seq: number) =>
		part(importKeys.sqlPrefix(orgId, operationId), seq, 'sql')
};

// #endregion

// #region reading a window

// the bytes from offset to offset + length of the parts as one stream; every part but the last is
// partBytes long, so the window needs at most the parts it overlaps
export async function readWindow(
	blobs: Pick<BackupBlobs, 'get'>,
	keyOf: (seq: number) => string,
	partBytes: number,
	total: number,
	offset: number,
	length: number
): Promise<Uint8Array> {
	const end = Math.min(total, offset + length);
	const out = new Uint8Array(Math.max(0, end - offset));
	let at = offset;
	while (at < end) {
		const seq = Math.floor(at / partBytes);
		const bytes = await blobs.get(keyOf(seq));
		if (bytes === null) throw new ImportError('part_missing', `part ${seq} is missing`);
		const from = at - seq * partBytes;
		const take = Math.min(end - at, bytes.byteLength - from);
		if (take <= 0)
			throw new ImportError('part_missing', `part ${seq} is shorter than recorded`);
		out.set(bytes.subarray(from, from + take), at - offset);
		at += take;
	}
	return out;
}

// #endregion

// #region the survey result

// what a survey leaves in the operation's cursor; the migration screens read the dossier from it
export interface SurveyCursor {
	v: 1;
	host: string;
	root: string;
	capturedAt: string | null;
	dossier: Dossier;
}

export function readSurveyCursor(cursor: string | null): SurveyCursor | null {
	if (cursor === null) return null;
	try {
		const parsed = JSON.parse(cursor) as Partial<SurveyCursor> | null;
		if (
			parsed === null ||
			typeof parsed !== 'object' ||
			parsed.v !== 1 ||
			typeof parsed.host !== 'string' ||
			typeof parsed.root !== 'string' ||
			typeof parsed.dossier !== 'object' ||
			parsed.dossier === null
		) {
			return null;
		}
		return parsed as SurveyCursor;
	} catch {
		return null;
	}
}

// #endregion
