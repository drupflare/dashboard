import { bundleKeys } from '../bundle';
import type { Releases } from '../ports';
import { PermanentError } from '../step';

export function releasesOf(baseUrl: string, fetcher: typeof fetch): Releases {
	const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;

	// a 404 is a refusal; any other bad answer is an interruption the step retries
	async function get(key: string): Promise<Response | null> {
		const response = await fetcher(`${base}${key}`);
		if (response.status === 404) return null;
		if (!response.ok) throw new Error(`${key} answered ${response.status}`);
		return response;
	}

	return {
		async manifest(releaseId) {
			const response = await get(bundleKeys.manifest(releaseId));
			if (response === null) {
				throw new PermanentError(
					'release_not_found',
					`no bundle manifest for ${releaseId}`
				);
			}
			try {
				return await response.json();
			} catch {
				throw new PermanentError(
					'release_manifest_unreadable',
					`the manifest for ${releaseId} is not JSON`
				);
			}
		},
		async part(key) {
			const response = await get(key);
			if (response === null) {
				throw new PermanentError('release_part_missing', `${key} is not published`);
			}
			return new Uint8Array(await response.arrayBuffer());
		}
	};
}
