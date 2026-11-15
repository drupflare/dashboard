import { sha256Hex, utf8 } from '@contracts/common';
import { z } from 'zod';
import type { DecodedFile } from '../../src/shared/modify';
import { PermanentError } from './step';

export const MODIFY_BUNDLE_VERSION = 1;

const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/;

function segment(value: string): string {
	if (!SEGMENT.test(value)) throw new PermanentError('bad_key', 'an edit key part is not an id');
	return value;
}

// one bundle per delivering operation; a rollback to an edit reads the key of the row it names
export const editKeys = {
	prefix: (orgId: string, siteId: string) => `edits/${segment(orgId)}/${segment(siteId)}/`,
	bundle: (orgId: string, siteId: string, operationId: string) =>
		`${editKeys.prefix(orgId, siteId)}${segment(operationId)}/bundle.json`
};

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const editBundleSchema = z.strictObject({
	v: z.literal(MODIFY_BUNDLE_VERSION),
	package: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
	files: z
		.array(
			z.strictObject({
				path: z.string().min(1),
				hash: sha256,
				bytes: z.int().nonnegative(),
				source: z.string()
			})
		)
		.min(1)
});

export type EditBundle = z.infer<typeof editBundleSchema>;

export async function buildEditBundle(
	name: string,
	files: readonly DecodedFile[]
): Promise<EditBundle> {
	return {
		v: MODIFY_BUNDLE_VERSION,
		package: name,
		files: await Promise.all(
			files.map(async (file) => ({
				path: file.path,
				hash: await sha256Hex(file.source),
				bytes: file.bytes,
				source: file.source
			}))
		)
	};
}

export const editBundleBytes = (bundle: EditBundle) => utf8(JSON.stringify(bundle));

// a bundle that no longer matches its own hashes is refused, whatever stored it
export async function parseEditBundle(bytes: Uint8Array): Promise<EditBundle> {
	let raw: unknown;
	try {
		raw = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new PermanentError('bundle_invalid', 'the stored files could not be read');
	}
	const parsed = editBundleSchema.safeParse(raw);
	if (!parsed.success) {
		throw new PermanentError('bundle_invalid', 'the stored files are not an edit bundle');
	}
	for (const file of parsed.data.files) {
		if ((await sha256Hex(file.source)) !== file.hash) {
			throw new PermanentError('bundle_invalid', 'a stored file does not match its hash');
		}
	}
	return parsed.data;
}

export const manifestOf = (bundle: EditBundle): Record<string, string> =>
	Object.fromEntries(bundle.files.map((file) => [file.path, file.hash]));

// the revision id the site gives a file set: sha256 over "path hash" lines sorted by path
export function revisionOf(bundle: EditBundle): Promise<string> {
	const manifest = manifestOf(bundle);
	return sha256Hex(
		Object.keys(manifest)
			.sort()
			.map((path) => `${path} ${manifest[path]}`)
			.join('\n')
	);
}
