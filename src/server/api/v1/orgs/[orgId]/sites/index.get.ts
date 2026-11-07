import { siteSchema } from '@contracts/sites';
import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { listReadySites, toSite } from '../../../../../db/repos/sites';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../../utils/pagination';

const cursorShape = z.object({ id: z.string().min(1) });

export default defineApi(
	{
		scope: 'organization',
		action: 'org.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'List sites',
		description:
			'Lists the sites of the organisation in the path in id order. Sites still being created are left out; read their operation instead.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({ items: z.array(siteSchema), nextCursor: z.string().nullable() })
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape).id;
		const rows = await listReadySites(await siteServices().getDb(), orgId, {
			after,
			count: limit + 1
		});
		const page = toPage(rows, limit, (row) => ({ id: row.id }));
		const { releases } = siteServices().config;
		return {
			items: page.items.map((row) => toSite(row, releases[row.kind] ?? null)),
			nextCursor: page.nextCursor
		};
	}
);
