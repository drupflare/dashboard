import type { R2Bucket } from '@cloudflare/workers-types';
import { bundleKeys } from '../bundle';
import type { Releases } from '../ports';
import { PermanentError } from '../step';

export function releasesOf(bucket: Pick<R2Bucket, 'get'>): Releases {
	return {
		async manifest(releaseId) {
			const object = await bucket.get(bundleKeys.manifest(releaseId));
			if (object === null) {
				throw new PermanentError(
					'release_not_found',
					`no bundle manifest for ${releaseId}`
				);
			}
			try {
				return await object.json();
			} catch {
				throw new PermanentError(
					'release_manifest_unreadable',
					`the manifest for ${releaseId} is not JSON`
				);
			}
		},
		async part(key) {
			const object = await bucket.get(key);
			if (object === null)
				throw new PermanentError('release_part_missing', `${key} is not stored`);
			return new Uint8Array(await object.arrayBuffer());
		}
	};
}
