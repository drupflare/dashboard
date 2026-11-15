import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { ApiError } from '../../shared/errors';
import { getRelease } from '../db/repos/releases';
import { getReadySite } from '../db/repos/sites';
import { guardRollback } from '../domain/rollback-guard';

export const rollbackCheckSchema = z.strictObject({
	siteId: z.string(),
	release: z.string(),
	allowed: z.boolean(),
	reason: z.string().nullable(),
	offers: z.array(z.enum(['restore-data-with-code', 'fix-forward']))
});

export type RollbackCheck = z.infer<typeof rollbackCheckSchema>;

// a site runs a worker release, so a target of another kind is refused unless the site's own
// release is registered as that kind
export async function checkRollback(
	services: { getDb: () => Promise<CollegeDBClient> },
	input: { orgId: string; siteId: string; release: string }
): Promise<RollbackCheck> {
	const db = await services.getDb();
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const target = await getRelease(db, input.release);
	if (target === null) {
		throw new ApiError('not_found', 'That release is not registered', {
			reason: 'release_unknown'
		});
	}
	const current = site.releaseId === null ? null : await getRelease(db, site.releaseId);
	const expected = current?.kind ?? 'worker';
	if (target.kind !== expected) {
		throw new ApiError('unprocessable', 'That release is not code this site can run', {
			reason: 'release_kind_mismatch'
		});
	}
	const verdict = guardRollback({
		dataSchemaVersion: site.dataSchemaVersion,
		target: { schemaVersion: target.schemaVersion, acceptsSchema: target.acceptsSchema }
	});
	return verdict.allowed
		? { siteId: site.id, release: target.id, allowed: true, reason: null, offers: [] }
		: {
				siteId: site.id,
				release: target.id,
				allowed: false,
				reason: verdict.reason,
				offers: verdict.offers
			};
}
