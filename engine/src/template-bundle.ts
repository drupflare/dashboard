import { sha256Hex } from '@contracts/common';
import { z } from 'zod';

export const BUNDLE_MAGIC = 'DFTB1\n';
export const BUNDLE_VERSION = 1;
// the engine holds a whole bundle in memory, so a build that writes more than this is refused
export const MAX_BUNDLE_BYTES = 48 * 1024 * 1024;

export const templateKeys = {
	build: (entryId: string, buildId: string) => `templates/${entryId}/${buildId}/bundle`
};

export class TemplateBundleError extends Error {
	constructor(
		readonly code:
			'bundle_too_large' | 'bundle_malformed' | 'bundle_mismatch' | 'bundle_section_missing',
		message: string
	) {
		super(message);
		this.name = 'TemplateBundleError';
	}
}

const section = z.object({
	name: z.string().min(1),
	bytes: z.number().int().min(0),
	sha256: z.string().regex(/^[0-9a-f]{64}$/)
});

export const templateManifestSchema = z.object({
	version: z.literal(BUNDLE_VERSION),
	entryId: z.string().min(1),
	commit: z.string().regex(/^[0-9a-f]{40}$/),
	phpVersion: z.string(),
	buildSeconds: z.number().min(0),
	rows: z.number().int().min(0),
	// null when the advisory check could not be read, which is not the same as none
	advisories: z.array(z.object({ id: z.string(), package: z.string() })).nullable(),
	patchesFailed: z.array(z.object({ package: z.string(), patch: z.string() })),
	packages: z.number().int().min(0),
	sections: z.array(section)
});
export type TemplateBundleManifest = z.infer<typeof templateManifestSchema>;

export interface TemplateBundle {
	manifest: TemplateBundleManifest;
	section(name: string): Uint8Array;
}

const decoder = new TextDecoder();

// every section is cut by its stated size and checked against its hash, so a cut or swapped
// bundle never reaches a site
export async function parseBundle(bytes: Uint8Array): Promise<TemplateBundle> {
	if (bytes.byteLength > MAX_BUNDLE_BYTES) {
		throw new TemplateBundleError(
			'bundle_too_large',
			'the bundle is larger than the engine reads'
		);
	}
	const prefix = BUNDLE_MAGIC.length + 4;
	if (
		bytes.byteLength < prefix ||
		decoder.decode(bytes.subarray(0, BUNDLE_MAGIC.length)) !== BUNDLE_MAGIC
	) {
		throw new TemplateBundleError(
			'bundle_malformed',
			'the bundle does not start with its header'
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const length = view.getUint32(BUNDLE_MAGIC.length);
	if (prefix + length > bytes.byteLength) {
		throw new TemplateBundleError('bundle_malformed', 'the bundle manifest is cut short');
	}
	let manifest: TemplateBundleManifest;
	try {
		manifest = templateManifestSchema.parse(
			JSON.parse(decoder.decode(bytes.subarray(prefix, prefix + length)))
		);
	} catch {
		throw new TemplateBundleError('bundle_malformed', 'the bundle manifest is not valid');
	}
	const parts = new Map<string, Uint8Array>();
	let at = prefix + length;
	for (const entry of manifest.sections) {
		const part = bytes.subarray(at, at + entry.bytes);
		if (part.byteLength !== entry.bytes) {
			throw new TemplateBundleError(
				'bundle_malformed',
				`the section ${entry.name} is cut short`
			);
		}
		if ((await sha256Hex(part)) !== entry.sha256) {
			throw new TemplateBundleError(
				'bundle_mismatch',
				`the section ${entry.name} does not match its hash`
			);
		}
		parts.set(entry.name, part);
		at += entry.bytes;
	}
	if (at !== bytes.byteLength) {
		throw new TemplateBundleError(
			'bundle_malformed',
			'the bundle has bytes after its last section'
		);
	}
	return {
		manifest,
		section(name) {
			const part = parts.get(name);
			if (part === undefined) {
				throw new TemplateBundleError(
					'bundle_section_missing',
					`the bundle has no ${name}`
				);
			}
			return part;
		}
	};
}
