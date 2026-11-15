import { z } from 'zod';

// the worker's default ceiling on one JSON request body (MAX_BODY_BYTES), used as the cap here
export const MODIFY_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
// unreviewed: the worker sets no count, and every file adds a path and a hash to two requests
export const MODIFY_MAX_FILES = 500;
// the worker cuts a label at 200 characters
export const MODIFY_NOTE_MAX = 200;
// {"blobs":[{"hash":"<64 hex>","source":"..."}]} around one file
export const MODIFY_BLOB_ENVELOPE_BYTES = 128;

export const MODIFY_ENCODINGS = ['utf8', 'base64'] as const;

export const modifyFileSchema = z.strictObject({
	path: z.string().min(1).max(240),
	content: z.string().max(MODIFY_MAX_REQUEST_BYTES * 2),
	encoding: z.enum(MODIFY_ENCODINGS).optional()
});

export const modifyBodySchema = z.strictObject({
	files: z.array(modifyFileSchema).min(1).max(MODIFY_MAX_FILES),
	note: z.string().trim().min(1).max(MODIFY_NOTE_MAX)
});

export const modifyRollbackBodySchema = z.strictObject({
	revision: z.string().min(1).max(128)
});

export type ModifyFileInput = z.infer<typeof modifyFileSchema>;
export type ModifyBody = z.infer<typeof modifyBodySchema>;

const ROOT = /^(modules|themes|profiles)\/custom\/([a-z][a-z0-9_]{0,63})\/.+$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;

export const MODIFY_PATH_RULE =
	'Files go in modules/custom/<name>/, themes/custom/<name>/ or profiles/custom/<name>/.';

// null when the path is one the site's edit route may take
export function modifyPathProblem(path: string): string | null {
	if (path.startsWith('/') || path.includes('\\')) {
		return 'Use a path relative to the Drupal root, with forward slashes.';
	}
	const segments = path.split('/');
	if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
		return 'A path cannot hold .. or empty parts.';
	}
	if (!segments.every((segment) => SEGMENT.test(segment))) {
		return 'A path can hold letters, digits, dots, dashes and underscores.';
	}
	return ROOT.test(path) ? null : MODIFY_PATH_RULE;
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export const MODIFY_TREES = {
	module: 'modules',
	theme: 'themes',
	profile: 'profiles'
} as const;

export type ModifyKind = keyof typeof MODIFY_TREES;

export const modifyRoot = (kind: ModifyKind, name: string) =>
	`${MODIFY_TREES[kind]}/custom/${name}/`;

// null when the name is a Drupal machine name: lowercase letters, digits and underscores
export function modifyNameProblem(name: string): string | null {
	return NAME.test(name)
		? null
		: 'Use a machine name: lowercase letters, digits and underscores, starting with a letter.';
}

// the machine name of the module, theme or profile a path sits in
export function modifyPackageOf(path: string): string | null {
	return ROOT.exec(path)?.[2] ?? null;
}

export interface DecodedFile {
	path: string;
	source: string;
	bytes: number;
}

export interface ModifyProblem {
	// the index in the list sent, null when the problem is about the whole set
	file: number | null;
	message: string;
}

export interface CheckedFiles {
	package: string;
	files: DecodedFile[];
	bytes: number;
}

const encoder = new TextEncoder();

// the blobs call carries one file as JSON, so escapes count against the ceiling
export function blobRequestBytes(source: string): number {
	return encoder.encode(JSON.stringify(source)).length + MODIFY_BLOB_ENVELOPE_BYTES;
}

function decode(file: ModifyFileInput): string | null {
	if (file.encoding !== 'base64') return file.content;
	try {
		const binary = atob(file.content.replace(/\s+/g, ''));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return null;
	}
}

const MIB = 1024 * 1024;

// the dashboard API refuses a request body above this (maxBodyBytes in define-api), which is
// below the worker's ceiling, so it is the cap a person meets first
export const MODIFY_MAX_API_BYTES = 1024 * 1024;

export function modifyRequestProblem(body: unknown): string | null {
	const size = encoder.encode(JSON.stringify(body)).length;
	return size > MODIFY_MAX_API_BYTES
		? `The request is ${(size / MIB).toFixed(2)} MiB. The dashboard takes up to ${MODIFY_MAX_API_BYTES / MIB} MiB at a time, so send fewer or smaller files.`
		: null;
}

// the same checks run in the form and on the server, so a file refused here is refused there
export function checkModifyFiles(
	files: readonly ModifyFileInput[]
): { ok: true; value: CheckedFiles } | { ok: false; problems: ModifyProblem[] } {
	const problems: ModifyProblem[] = [];
	const decoded: DecodedFile[] = [];
	const seen = new Set<string>();
	let packageName: string | null = null;
	let bytes = 0;
	for (const [index, file] of files.entries()) {
		const problem = modifyPathProblem(file.path);
		if (problem !== null) {
			problems.push({ file: index, message: problem });
			continue;
		}
		if (seen.has(file.path)) {
			problems.push({ file: index, message: 'This path is listed twice.' });
			continue;
		}
		seen.add(file.path);
		const name = modifyPackageOf(file.path);
		packageName ??= name;
		if (name !== packageName) {
			problems.push({
				file: index,
				message: 'Every file in one edit must sit in the same module, theme or profile.'
			});
			continue;
		}
		const source = decode(file);
		if (source === null) {
			problems.push({
				file: index,
				message:
					'The content is not base64 for UTF-8 text. The site stores module files as text.'
			});
			continue;
		}
		if (blobRequestBytes(source) > MODIFY_MAX_REQUEST_BYTES) {
			problems.push({
				file: index,
				message: `This file is too large to send. One file can take up to ${MODIFY_MAX_REQUEST_BYTES / MIB} MiB.`
			});
			continue;
		}
		const size = encoder.encode(source).length;
		bytes += size;
		decoded.push({ path: file.path, source, bytes: size });
	}
	if (problems.length === 0 && bytes > MODIFY_MAX_REQUEST_BYTES) {
		problems.push({
			file: null,
			message: `The files add up to more than ${MODIFY_MAX_REQUEST_BYTES / MIB} MiB. Send fewer or smaller files.`
		});
	}
	if (problems.length > 0 || packageName === null) {
		return { ok: false, problems };
	}
	return { ok: true, value: { package: packageName, files: decoded, bytes } };
}
