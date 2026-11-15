import type { D1Database } from '@cloudflare/workers-types';
import { bundleKeys } from '../bundle';
import { customReleasePrefix } from '../custom-bundle';

// what a purge asks of the stored bundles of the site it removes
export interface CustomBundlePurge {
	// the release ids whose bundle objects and row were removed
	purgeFor(siteId: string): Promise<string[]>;
}

interface IdRow {
	release_id: string;
}

// A bundle is one release per organisation and archive, so two sites of one organisation can run
// the same one. It goes only when no other site that is not yet purged still names it.
export function customBundlesOf(
	db: D1Database,
	blobs: { deletePrefix(prefix: string): Promise<number> }
): CustomBundlePurge {
	return {
		async purgeFor(siteId) {
			const { results } = await db
				.prepare(
					`SELECT release_id FROM site_revisions WHERE site_id = ? AND release_id LIKE ?
					 UNION SELECT release_id FROM sites WHERE id = ? AND release_id LIKE ?`
				)
				.bind(siteId, `${customReleasePrefix}%`, siteId, `${customReleasePrefix}%`)
				.all<IdRow>();
			const removed: string[] = [];
			for (const { release_id: releaseId } of results) {
				// the row goes last, so a release without one has had its objects removed already
				const row = await db
					.prepare('SELECT bundle_key FROM custom_releases WHERE id = ?')
					.bind(releaseId)
					.first<{ bundle_key: string }>();
				if (row === null) continue;
				const named = await db
					.prepare(
						`SELECT 1 AS hit FROM sites s WHERE s.id != ? AND s.state != 'deleted'
						 AND (s.release_id = ? OR EXISTS (SELECT 1 FROM site_revisions r
							WHERE r.site_id = s.id AND r.release_id = ?))
						 LIMIT 1`
					)
					.bind(siteId, releaseId, releaseId)
					.first<{ hit: number }>();
				if (named !== null) continue;
				await blobs.deletePrefix(
					bundleKeys.manifest(releaseId).replace('manifest.json', '')
				);
				await blobs.deletePrefix(row.bundle_key);
				await db.prepare('DELETE FROM custom_releases WHERE id = ?').bind(releaseId).run();
				removed.push(releaseId);
			}
			return removed;
		}
	};
}
