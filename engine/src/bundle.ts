import { sha256Hex } from '@contracts/common';
import { z } from 'zod';
import { PermanentError } from './step';

export const BUNDLE_VERSION = 1;

export const MODULE_CONTENT_TYPES = [
	'application/javascript+module',
	'application/javascript',
	'text/plain',
	'application/octet-stream',
	'application/wasm'
] as const;

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const assetHash = z.string().regex(/^[0-9a-f]{32}$/);
const size = z.int().nonnegative();

export const bundleManifestSchema = z
	.object({
		v: z.literal(BUNDLE_VERSION),
		releaseId: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
		workerCommit: z.string().regex(/^[0-9a-f]{40}$/),
		mainModule: z.string().min(1),
		modules: z.array(
			z.object({
				name: z.string().min(1),
				contentType: z.enum(MODULE_CONTENT_TYPES),
				sha256,
				size
			})
		),
		metadata: z.object({ sha256, size }),
		assets: z.array(z.object({ path: z.string().startsWith('/'), hash: assetHash, size })),
		counts: z.object({ modules: size, assets: size })
	})
	.strict();

export type BundleManifest = z.infer<typeof bundleManifestSchema>;
export type BundleModule = BundleManifest['modules'][number];
export type BundleAsset = BundleManifest['assets'][number];

export interface BundleLimits {
	maxModuleBytes: number;
	maxTotalBytes: number;
	maxAssetBytes: number;
	maxAssets: number;
}

export const BUNDLE_ERROR_CODES = [
	'malformed',
	'missing_hash',
	'missing_main',
	'duplicate_path',
	'count_mismatch',
	'oversize_module',
	'oversize_asset',
	'oversize_bundle',
	'too_many_assets',
	'hash_mismatch',
	'size_mismatch',
	'invalid_limits'
] as const;
export type BundleErrorCode = (typeof BUNDLE_ERROR_CODES)[number];

export class BundleError extends PermanentError {
	declare readonly code: BundleErrorCode;

	constructor(code: BundleErrorCode, message: string) {
		super(code, message);
	}
}

export const bundleKeys = {
	manifest: (releaseId: string) => `releases/${releaseId}/manifest.json`,
	metadata: (releaseId: string) => `releases/${releaseId}/metadata.json`,
	module: (releaseId: string, name: string) => `releases/${releaseId}/modules/${name}`,
	asset: (releaseId: string, hash: string) => `releases/${releaseId}/assets/${hash}`
};

// the asset api keys on a sha-256 cut to 32 hex characters
export async function assetHashOf(bytes: Uint8Array): Promise<string> {
	return (await sha256Hex(bytes)).slice(0, 32);
}

export function parseManifest(raw: unknown): BundleManifest {
	const parsed = bundleManifestSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	const issue = parsed.error.issues[0];
	const path = issue?.path.join('.') ?? '';
	const code = /(^|\.)(sha256|hash)$/.test(path) ? 'missing_hash' : 'malformed';
	throw new BundleError(code, `${path || 'manifest'}: ${issue?.message ?? 'invalid'}`);
}

function assertLimits(limits: BundleLimits): void {
	for (const [name, value] of Object.entries(limits)) {
		if (!Number.isSafeInteger(value) || value <= 0) {
			throw new BundleError('invalid_limits', `${name} must be a positive whole number`);
		}
	}
}

function noDuplicates(values: readonly string[], what: string): void {
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value))
			throw new BundleError('duplicate_path', `${what} ${value} appears twice`);
		seen.add(value);
	}
}

export function validateBundle(raw: unknown, limits: BundleLimits): BundleManifest {
	assertLimits(limits);
	const manifest = parseManifest(raw);
	if (!manifest.modules.some((module) => module.name === manifest.mainModule)) {
		throw new BundleError('missing_main', `${manifest.mainModule} is not among the modules`);
	}
	if (
		manifest.counts.modules !== manifest.modules.length ||
		manifest.counts.assets !== manifest.assets.length
	) {
		throw new BundleError(
			'count_mismatch',
			`the manifest counts ${manifest.counts.modules} modules and ${manifest.counts.assets} assets ` +
				`but lists ${manifest.modules.length} and ${manifest.assets.length}`
		);
	}
	noDuplicates(
		manifest.modules.map((module) => module.name),
		'module'
	);
	noDuplicates(
		manifest.assets.map((asset) => asset.path),
		'asset'
	);
	for (const module of manifest.modules) {
		if (module.size > limits.maxModuleBytes) {
			throw new BundleError(
				'oversize_module',
				`${module.name} is ${module.size} bytes, over ${limits.maxModuleBytes}`
			);
		}
	}
	for (const asset of manifest.assets) {
		if (asset.size > limits.maxAssetBytes) {
			throw new BundleError(
				'oversize_asset',
				`${asset.path} is ${asset.size} bytes, over ${limits.maxAssetBytes}`
			);
		}
	}
	if (manifest.assets.length > limits.maxAssets) {
		throw new BundleError(
			'too_many_assets',
			`${manifest.assets.length} assets are over the limit of ${limits.maxAssets}`
		);
	}
	const total =
		manifest.modules.reduce((sum, module) => sum + module.size, 0) +
		manifest.metadata.size +
		manifest.assets.reduce((sum, asset) => sum + asset.size, 0);
	if (total > limits.maxTotalBytes) {
		throw new BundleError('oversize_bundle', `${total} bytes are over ${limits.maxTotalBytes}`);
	}
	return manifest;
}

// buckets come from the asset api and stay apart; a bucket over the byte budget splits, and a
// file bigger than the budget goes alone
export function planChunks(
	buckets: readonly (readonly string[])[],
	sizeOf: (hash: string) => number,
	chunkBytes: number
): string[][] {
	if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) {
		throw new BundleError('invalid_limits', 'chunkBytes must be a positive whole number');
	}
	const chunks: string[][] = [];
	for (const bucket of buckets) {
		let current: string[] = [];
		let bytes = 0;
		for (const hash of bucket) {
			const size = sizeOf(hash);
			if (current.length > 0 && bytes + size > chunkBytes) {
				chunks.push(current);
				current = [];
				bytes = 0;
			}
			current.push(hash);
			bytes += size;
		}
		if (current.length > 0) chunks.push(current);
	}
	return chunks;
}

export async function checkModuleBytes(module: BundleModule, bytes: Uint8Array): Promise<void> {
	if (bytes.byteLength !== module.size) {
		throw new BundleError(
			'size_mismatch',
			`${module.name} is ${bytes.byteLength} bytes, not ${module.size}`
		);
	}
	if ((await sha256Hex(bytes)) !== module.sha256) {
		throw new BundleError('hash_mismatch', `${module.name} does not match its sha256`);
	}
}

export async function checkMetadataBytes(
	manifest: BundleManifest,
	bytes: Uint8Array
): Promise<void> {
	if (bytes.byteLength !== manifest.metadata.size) {
		throw new BundleError('size_mismatch', 'the metadata blob has the wrong size');
	}
	if ((await sha256Hex(bytes)) !== manifest.metadata.sha256) {
		throw new BundleError('hash_mismatch', 'the metadata blob does not match its sha256');
	}
}

export async function checkAssetBytes(asset: BundleAsset, bytes: Uint8Array): Promise<void> {
	if (bytes.byteLength !== asset.size) {
		throw new BundleError(
			'size_mismatch',
			`${asset.path} is ${bytes.byteLength} bytes, not ${asset.size}`
		);
	}
	if ((await assetHashOf(bytes)) !== asset.hash) {
		throw new BundleError('hash_mismatch', `${asset.path} does not match its hash`);
	}
}
