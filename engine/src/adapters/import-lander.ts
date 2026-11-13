import type { Custody } from '../custody';
import type { BackupWorker, ImportLander } from '../ports';

// the database and the files rows land through the site's own restore, as a restored backup does
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
			)
	};
}
