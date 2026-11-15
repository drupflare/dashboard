import type { CollegeDBClient } from '@earth-app/collegedb';
import { z } from 'zod';
import { isCustomRelease } from '../../../engine/src/custom-bundle';
import { ApiError } from '../../shared/errors';
import { customReleaseNotes, getCustomRelease } from '../db/repos/custom-releases';
import { getRelease } from '../db/repos/releases';
import { listSiteRevisions } from '../db/repos/site-revisions';
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

export const revisionItemSchema = z.strictObject({
	id: z.string(),
	kind: z.enum(['release', 'edit']),
	release: z.string().nullable(),
	version: z.string().nullable(),
	note: z.string().nullable(),
	createdAt: z.number().int(),
	current: z.boolean(),
	// an edit that kept its files, so it can be rolled back to
	bundle: z.boolean()
});

export const revisionListSchema = z.strictObject({ items: z.array(revisionItemSchema) });

export type RevisionItem = z.infer<typeof revisionItemSchema>;

export const REVISION_LIMIT = 50;

// only the newest release row that names the site's release is current, since a release can come
// back; the newest edit is the files the site holds now
export async function listRevisions(
	services: { getDb: () => Promise<CollegeDBClient> },
	input: { orgId: string; siteId: string }
): Promise<{ items: RevisionItem[] }> {
	const db = await services.getDb();
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	const rows = await listSiteRevisions(db, input.orgId, input.siteId, REVISION_LIMIT);
	const versions = new Map<string, string | null>();
	for (const row of rows) {
		if (
			row.releaseId !== null &&
			!versions.has(row.releaseId) &&
			!isCustomRelease(row.releaseId)
		) {
			versions.set(row.releaseId, (await getRelease(db, row.releaseId))?.version ?? null);
		}
	}
	// a bundle has no version; the file it came in and the start of its hash say which one it was
	const bundleNotes = await customReleaseNotes(
		db,
		input.orgId,
		rows.flatMap((row) =>
			row.releaseId !== null && isCustomRelease(row.releaseId) ? [row.releaseId] : []
		)
	);
	const seen = { release: false, edit: false };
	const items = rows.map((row) => {
		const current =
			!seen[row.kind] &&
			(row.kind === 'edit' || (row.releaseId !== null && row.releaseId === site.releaseId));
		if (current) seen[row.kind] = true;
		return {
			id: row.id,
			kind: row.kind,
			release: row.releaseId,
			version: row.releaseId === null ? null : (versions.get(row.releaseId) ?? null),
			note:
				row.note ??
				(row.releaseId === null ? null : (bundleNotes.get(row.releaseId) ?? null)),
			createdAt: row.createdAt,
			current,
			bundle: row.kind === 'edit' && row.bundleKey !== null
		};
	});
	return { items };
}

// a site runs a worker release, so a target of another kind is refused unless the site's own
// release is registered as that kind
export async function checkRollback(
	services: { getDb: () => Promise<CollegeDBClient> },
	input: { orgId: string; siteId: string; release: string }
): Promise<RollbackCheck> {
	const db = await services.getDb();
	const site = await getReadySite(db, input.orgId, input.siteId);
	if (site === null) throw new ApiError('not_found', 'Not found');
	if (site.kind === 'custom' || isCustomRelease(input.release)) {
		// a bundle stores no data version of its own; the migration check of the engine is its guard
		const bundle =
			site.kind === 'custom' ? await getCustomRelease(db, input.orgId, input.release) : null;
		if (bundle === null) {
			throw new ApiError('not_found', 'That release is not registered', {
				reason: 'release_unknown'
			});
		}
		return { siteId: site.id, release: bundle.id, allowed: true, reason: null, offers: [] };
	}
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
