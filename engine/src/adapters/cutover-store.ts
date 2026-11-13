import { z } from 'zod';
import { partKey } from '../import-parts';
import type { BackupBlobs } from '../ports';
import { PermanentError } from '../step';

// the key of a fresh SSH credential, then the docroot on the old server: `imc_...` + `/var/www/html`
const REF = /^(imc_[a-z2-7]{26})(\/[^\s\u0000-\u001f]*)$/;

export function parseSourceRef(ref: string): { credentialId: string; root: string } | null {
	const found = REF.exec(ref);
	return found === null ? null : { credentialId: found[1]!, root: found[2]! };
}

export const COPY_LABELS = ['snapshot', 'capture-delta', 'final-delta'] as const;
export type CopyLabel = (typeof COPY_LABELS)[number];

const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;
const MARKER = /^(snapshot|capture-delta|final-delta):([0-9a-f]{16})$/;

// a key is the operation id and the step, joined by a colon
export function keyParts(key: string): { operationId: string; label: string } {
	const at = key.indexOf(':');
	const operationId = at < 0 ? key : key.slice(0, at);
	if (!SEGMENT.test(operationId)) {
		throw new PermanentError(
			'cutover_key',
			'a cutover key does not start with an operation id'
		);
	}
	return { operationId, label: at < 0 ? '' : key.slice(at + 1) };
}

function segment(value: string): string {
	if (!SEGMENT.test(value)) throw new PermanentError('cutover_key', 'a key part is not an id');
	return value;
}

export const cutoverKeys = {
	prefix: (orgId: string, operationId: string) =>
		`cutover/${segment(orgId)}/${segment(operationId)}/`,
	copy: (orgId: string, operationId: string, label: CopyLabel) =>
		`${cutoverKeys.prefix(orgId, operationId)}${label}/`,
	dump: (copy: string) => `${copy}dump/`,
	sql: (copy: string) => `${copy}sql/`,
	manifest: (copy: string) => `${copy}manifest.json`,
	policy: (orgId: string, operationId: string) =>
		`${cutoverKeys.prefix(orgId, operationId)}policy.json`,
	changes: (orgId: string, operationId: string) =>
		`${cutoverKeys.prefix(orgId, operationId)}changes/`,
	progress: (changes: string, read: 'first' | 'final') => `${changes}progress-${read}.json`
};

// what the new site took since the move, saved as SQL parts for the owner to download
export const changesManifestSchema = z.strictObject({
	parts: z.int().nonnegative(),
	bytes: z.int().nonnegative(),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
	statements: z.int().nonnegative(),
	through: z.int().nonnegative(),
	takenAt: z.int(),
	// the read after the address moved back; the fields above then cover both reads and these
	// the second one alone
	final: z
		.strictObject({
			since: z.int().nonnegative(),
			parts: z.int().nonnegative(),
			bytes: z.int().nonnegative(),
			statements: z.int().nonnegative(),
			takenAt: z.int()
		})
		.optional()
});

export type ChangesManifest = z.infer<typeof changesManifestSchema>;

// how far one read of the change list has got: the windows saved so far, so a replay carries on from
// the cursor. The totals cover this read's own parts, and the hashes name them in order
export const changesProgressSchema = z.strictObject({
	since: z.int().nonnegative(),
	target: z.int().nonnegative(),
	cursor: z.int().nonnegative(),
	bytes: z.int().nonnegative(),
	statements: z.int().nonnegative(),
	hashes: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
	incomplete: z.enum(['journal_full', 'capture_failed']).nullable()
});

export type ChangesProgress = z.infer<typeof changesProgressSchema>;

// the mark the new site counts under, one per move; the worker accepts 64 characters
export function markOf(operationId: string): string {
	const mark = `cutover-${operationId}`;
	if (mark.length > 64) {
		throw new PermanentError('cutover_key', 'the operation id is too long to name a count');
	}
	return mark;
}

export const copyManifestSchema = z.strictObject({
	label: z.enum(COPY_LABELS),
	parts: z.int().nonnegative(),
	bytes: z.int().nonnegative(),
	digest: z.string().regex(/^[0-9a-f]{64}$/),
	tables: z.array(z.string()).nullable(),
	takenAt: z.int()
});

export type CopyManifest = z.infer<typeof copyManifestSchema>;

export const markerOf = (manifest: Pick<CopyManifest, 'label' | 'digest'>) =>
	`${manifest.label}:${manifest.digest.slice(0, 16)}`;

export function parseMarker(marker: string): { label: CopyLabel; short: string } {
	const found = MARKER.exec(marker);
	if (found === null) {
		throw new PermanentError('marker_unknown', 'a copy marker is not one this move made');
	}
	return { label: found[1] as CopyLabel, short: found[2]! };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const utf8 = (text: string) => new TextEncoder().encode(text);

export async function writeManifest(
	blobs: Pick<BackupBlobs, 'put'>,
	copy: string,
	manifest: CopyManifest
): Promise<void> {
	await blobs.put(cutoverKeys.manifest(copy), utf8(JSON.stringify(manifest)));
}

export async function readManifest(
	blobs: Pick<BackupBlobs, 'get'>,
	copy: string
): Promise<CopyManifest | null> {
	const bytes = await blobs.get(cutoverKeys.manifest(copy));
	if (bytes === null) return null;
	try {
		return copyManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
	} catch {
		return null;
	}
}

// the manifest a marker names, or null when none matches; a marker never reaches another move's copy
// because the key holds the operation id
export async function manifestOfMarker(
	blobs: Pick<BackupBlobs, 'get'>,
	orgId: string,
	operationId: string,
	marker: string
): Promise<{ manifest: CopyManifest; copy: string } | null> {
	const { label, short } = parseMarker(marker);
	const copy = cutoverKeys.copy(orgId, operationId, label);
	const manifest = await readManifest(blobs, copy);
	if (manifest === null || manifest.digest.slice(0, 16) !== short) return null;
	return { manifest, copy };
}

// the converted parts in order, each checked against the manifest's digest of digests
export async function readCopy(
	blobs: Pick<BackupBlobs, 'get'>,
	copy: string,
	manifest: CopyManifest
): Promise<Uint8Array | null> {
	const hashes: string[] = [];
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (let seq = 0; seq < manifest.parts; seq++) {
		const bytes = await blobs.get(partKey(cutoverKeys.sql(copy), seq, 'sql'));
		if (bytes === null) return null;
		hashes.push(await sha256Hex(bytes));
		chunks.push(bytes);
		total += bytes.byteLength;
	}
	if (total !== manifest.bytes || (await sha256Hex(utf8(hashes.join(',')))) !== manifest.digest) {
		return null;
	}
	const joined = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.byteLength;
	}
	return joined;
}

export async function digestOfParts(hashes: string[]): Promise<string> {
	return sha256Hex(utf8(hashes.join(',')));
}
