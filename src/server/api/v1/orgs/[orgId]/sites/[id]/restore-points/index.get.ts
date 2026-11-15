import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { backupServices } from '../../../../../../../services/backups';
import { listRestorePoints } from '../../../../../../../services/restore-points';
import { defineApi } from '../../../../../../../utils/define-api';
import { resolveLimit } from '../../../../../../../utils/pagination';

const restorePointSchema = z.strictObject({
	id: z.string(),
	layer: z.literal('export'),
	createdAt: z.string(),
	label: z.string().nullable(),
	verified: z.boolean(),
	moves: z.array(z.string()),
	doesNotMove: z.array(z.string())
});

const layerOfferSchema = z.strictObject({
	layer: z.literal('pitr'),
	windowDays: z.number().int().positive(),
	moves: z.array(z.string()),
	doesNotMove: z.array(z.string())
});

export default defineApi(
	{
		scope: 'site',
		action: 'site.restore-point.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'List the restore points of a site',
		description:
			'Lists the saved copies of the site, newest first, each with what it restores and what it does not. Point-in-time recovery is listed once as a layer with its window, not as one row per moment. A copy counts as verified only after a test restore passes.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({
			items: z.array(restorePointSchema),
			nextCursor: z.string().nullable(),
			layers: z.array(layerOfferSchema)
		})
	},
	async ({ principal, resource, params, query }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return listRestorePoints(backupServices(), {
			orgId,
			siteId: resolved,
			cursor: query.cursor,
			limit: resolveLimit(query.limit === undefined ? undefined : Number(query.limit))
		});
	}
);
