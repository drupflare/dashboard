import { hashAsset, MODULE_CONTENT_TYPE } from '@drupflare/workforce';
import { describe, expect, it } from 'vitest';
import {
	assetHashOf,
	BUNDLE_ERROR_CODES,
	BundleError,
	bundleKeys,
	checkAssetBytes,
	checkMetadataBytes,
	checkModuleBytes,
	MODULE_CONTENT_TYPES,
	parseManifest,
	planChunks,
	validateBundle,
	type BundleErrorCode,
	type BundleLimits,
	type BundleManifest
} from '../../../engine/src/bundle';
import { makeBundle } from './fakes';

const LIMITS: BundleLimits = {
	maxModuleBytes: 1_000_000,
	maxTotalBytes: 10_000_000,
	maxAssetBytes: 100_000,
	maxAssets: 100
};

const seen = new Set<BundleErrorCode>();
function codeOf(action: () => unknown): BundleErrorCode {
	try {
		action();
	} catch (error) {
		if (error instanceof BundleError) {
			seen.add(error.code);
			return error.code;
		}
		throw error;
	}
	throw new Error('expected a refusal');
}

async function rejectedWith(promise: Promise<unknown>): Promise<BundleErrorCode> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof BundleError) {
			seen.add(error.code);
			return error.code;
		}
		throw error;
	}
	throw new Error('expected a refusal');
}

async function manifest(): Promise<BundleManifest> {
	return structuredClone((await makeBundle()).manifest);
}

describe('the manifest', () => {
	it('accepts a well-formed bundle and returns it unchanged', async () => {
		const good = await manifest();
		expect(validateBundle(good, LIMITS)).toEqual(good);
	});

	it('refuses a module or asset with no hash, and a malformed one', async () => {
		const noModuleHash = await manifest();
		delete (noModuleHash.modules[0] as Partial<BundleManifest['modules'][number]>).sha256;
		expect(codeOf(() => validateBundle(noModuleHash, LIMITS))).toBe('missing_hash');
		const noAssetHash = await manifest();
		delete (noAssetHash.assets[0] as Partial<BundleManifest['assets'][number]>).hash;
		expect(codeOf(() => validateBundle(noAssetHash, LIMITS))).toBe('missing_hash');
		const noMetadataHash = await manifest();
		delete (noMetadataHash.metadata as Partial<BundleManifest['metadata']>).sha256;
		expect(codeOf(() => validateBundle(noMetadataHash, LIMITS))).toBe('missing_hash');
		const shortHash = await manifest();
		shortHash.assets[0]!.hash = 'abc';
		expect(codeOf(() => validateBundle(shortHash, LIMITS))).toBe('missing_hash');
		expect(codeOf(() => parseManifest({ v: 2 }))).toBe('malformed');
		expect(codeOf(() => parseManifest(null))).toBe('malformed');
	});

	it('refuses a count that does not match the lists', async () => {
		const wrongAssets = await manifest();
		wrongAssets.counts.assets += 1;
		expect(codeOf(() => validateBundle(wrongAssets, LIMITS))).toBe('count_mismatch');
		const wrongModules = await manifest();
		wrongModules.counts.modules -= 1;
		expect(codeOf(() => validateBundle(wrongModules, LIMITS))).toBe('count_mismatch');
	});

	it('refuses a module over the size gate, an asset over its gate and a bundle over the total', async () => {
		const good = await manifest();
		expect(codeOf(() => validateBundle(good, { ...LIMITS, maxModuleBytes: 10 }))).toBe(
			'oversize_module'
		);
		expect(codeOf(() => validateBundle(good, { ...LIMITS, maxAssetBytes: 10 }))).toBe(
			'oversize_asset'
		);
		expect(codeOf(() => validateBundle(good, { ...LIMITS, maxTotalBytes: 100 }))).toBe(
			'oversize_bundle'
		);
	});

	it('accepts a size exactly at its gate and refuses one byte over', async () => {
		const good = await manifest();
		const biggest = Math.max(...good.modules.map((module) => module.size));
		expect(() => validateBundle(good, { ...LIMITS, maxModuleBytes: biggest })).not.toThrow();
		expect(codeOf(() => validateBundle(good, { ...LIMITS, maxModuleBytes: biggest - 1 }))).toBe(
			'oversize_module'
		);
	});

	it('refuses more files than the gate allows, and accepts exactly the gate', async () => {
		const good = await manifest();
		const count = good.assets.length;
		expect(() => validateBundle(good, { ...LIMITS, maxAssets: count })).not.toThrow();
		expect(codeOf(() => validateBundle(good, { ...LIMITS, maxAssets: count - 1 }))).toBe(
			'too_many_assets'
		);
	});

	it('refuses a missing entry module and a path or name that repeats', async () => {
		const noMain = await manifest();
		noMain.mainModule = 'nowhere.js';
		expect(codeOf(() => validateBundle(noMain, LIMITS))).toBe('missing_main');
		const twiceModule = await manifest();
		twiceModule.modules.push({ ...twiceModule.modules[0]! });
		twiceModule.counts.modules += 1;
		expect(codeOf(() => validateBundle(twiceModule, LIMITS))).toBe('duplicate_path');
		const twiceAsset = await manifest();
		twiceAsset.assets.push({ ...twiceAsset.assets[0]! });
		twiceAsset.counts.assets += 1;
		expect(codeOf(() => validateBundle(twiceAsset, LIMITS))).toBe('duplicate_path');
	});

	it('refuses limits that are not positive whole numbers', async () => {
		const good = await manifest();
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(codeOf(() => validateBundle(good, { ...LIMITS, maxAssets: bad }))).toBe(
				'invalid_limits'
			);
		}
	});

	it('lets two paths share one hash, since the asset api keys on content', async () => {
		const good = await manifest();
		good.assets.push({ ...good.assets[0]!, path: '/copy.txt' });
		good.counts.assets += 1;
		expect(() => validateBundle(good, LIMITS)).not.toThrow();
	});
});

describe('the bytes behind the manifest', () => {
	it('accepts bytes that match and refuses a changed or truncated part', async () => {
		const bundle = await makeBundle();
		const module = bundle.manifest.modules[0]!;
		const bytes = bundle.parts.get(bundleKeys.module('v1.0.4', module.name))!;
		await expect(checkModuleBytes(module, bytes)).resolves.toBeUndefined();
		const altered = new Uint8Array(bytes);
		altered[0] = altered[0]! ^ 1;
		expect(await rejectedWith(checkModuleBytes(module, altered))).toBe('hash_mismatch');
		expect(await rejectedWith(checkModuleBytes(module, bytes.slice(1)))).toBe('size_mismatch');

		const asset = bundle.manifest.assets[0]!;
		const assetBytes = bundle.parts.get(bundleKeys.asset('v1.0.4', asset.hash))!;
		await expect(checkAssetBytes(asset, assetBytes)).resolves.toBeUndefined();
		expect(await rejectedWith(checkAssetBytes(asset, new TextEncoder().encode('x')))).toBe(
			'size_mismatch'
		);
		const sameSize = new Uint8Array(assetBytes);
		sameSize[0] = sameSize[0]! ^ 1;
		expect(await rejectedWith(checkAssetBytes(asset, sameSize))).toBe('hash_mismatch');

		const metadata = bundle.parts.get(bundleKeys.metadata('v1.0.4'))!;
		await expect(checkMetadataBytes(bundle.manifest, metadata)).resolves.toBeUndefined();
		expect(await rejectedWith(checkMetadataBytes(bundle.manifest, metadata.slice(1)))).toBe(
			'size_mismatch'
		);
		const flipped = new Uint8Array(metadata);
		flipped[0] = flipped[0]! ^ 1;
		expect(await rejectedWith(checkMetadataBytes(bundle.manifest, flipped))).toBe(
			'hash_mismatch'
		);
	});

	it('hashes an asset the way the asset api does', async () => {
		const bytes = new TextEncoder().encode('hello assets');
		expect(await assetHashOf(bytes)).toBe(await hashAsset(bytes));
	});

	it('uses the content types workforce uploads with', () => {
		const known = Object.values(MODULE_CONTENT_TYPE).filter(
			(type) => type !== 'application/source-map'
		);
		expect([...MODULE_CONTENT_TYPES].sort()).toEqual([...known].sort());
	});
});

describe('planChunks', () => {
	const size = (hash: string) => Number(hash.slice(1));

	it('keeps buckets apart and splits one that is over the byte budget', () => {
		expect(planChunks([['a10', 'a10', 'a10'], ['a5']], size, 20)).toEqual([
			['a10', 'a10'],
			['a10'],
			['a5']
		]);
	});

	it('puts a file bigger than the budget in a chunk of its own', () => {
		expect(planChunks([['a5', 'a100', 'a5']], size, 20)).toEqual([['a5'], ['a100'], ['a5']]);
	});

	it('never loses or repeats a file and never makes an empty chunk', () => {
		const buckets = [['a3', 'a4', 'a5', 'a6'], [], ['a7']];
		const chunks = planChunks(buckets, size, 9);
		expect(chunks.flat()).toEqual(buckets.flat());
		expect(chunks.every((chunk) => chunk.length > 0)).toBe(true);
		for (const chunk of chunks) {
			expect(
				chunk.length === 1 || chunk.reduce((sum, hash) => sum + size(hash), 0) <= 9
			).toBe(true);
		}
	});

	it('refuses a chunk size that is not a positive whole number', () => {
		for (const bad of [0, -5, 2.5]) {
			expect(codeOf(() => planChunks([['a1']], size, bad))).toBe('invalid_limits');
		}
	});
});

describe('typed errors', () => {
	it('has tripped every code the bundle can raise', () => {
		expect([...seen].sort()).toEqual([...BUNDLE_ERROR_CODES].sort());
	});
});
