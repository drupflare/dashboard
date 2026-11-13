import type { Custody } from '../custody';
import { ImportError } from '../import-parts';
import type { BackupWorker, ImportLander } from '../ports';

// the database lands through the site's own restore route, as a restored backup does. The files
// archive has no route on the site to land through, so that call refuses until one exists
export function createImportLander(deps: {
	custody: Pick<Custody, 'withOwnerToken'>;
	worker: BackupWorker;
}): ImportLander {
	const { custody, worker } = deps;
	return {
		database: (site, label, body) =>
			custody.withOwnerToken(site.siteId, site.ownerTokenId, async (bearer) => {
				// the label is the operation id, so a resumed step finds its own import and sends nothing
				const state = await worker.importState(site.hostname, label, { bearer });
				if (state === 'absent')
					await worker.restore(site.hostname, body, label, { bearer });
			}),
		state: (site, label) =>
			custody.withOwnerToken(site.siteId, site.ownerTokenId, (bearer) =>
				worker.importState(site.hostname, label, { bearer })
			),
		reason: (site, label) =>
			custody.withOwnerToken(site.siteId, site.ownerTokenId, (bearer) =>
				worker.importReason(site.hostname, label, { bearer })
			),
		async files() {
			throw new ImportError(
				'files_landing_unavailable',
				'the new site has no route that takes a files archive yet'
			);
		}
	};
}
