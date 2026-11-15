import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	listSiteRepairs,
	repairViewSchema,
	toRepairView
} from '../../../../../../../services/repairs';
import { siteServices } from '../../../../../../../services/sites';
import { defineApi } from '../../../../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../../../../utils/pagination';

const cursorShape = z.object({ createdAt: z.number().int().nonnegative(), id: z.string().min(1) });

export default defineApi(
	{
		scope: 'site',
		action: 'site.repair.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'List the automatic repairs of a site',
		description:
			'Lists the automatic repairs made on the site in the path, newest first, with what was seen before and after each one and whether Undo is offered.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({ items: z.array(repairViewSchema), nextCursor: z.string().nullable() })
	},
	async ({ resource, params, query }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape);
		const rows = await listSiteRepairs(siteServices(), {
			orgId,
			siteId: resolvedSite,
			after,
			count: limit + 1
		});
		const page = toPage(rows, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
		return {
			items: page.items.map(toRepairView),
			nextCursor: page.nextCursor
		};
	}
);
