import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { nodePageSchema } from '../../../../../../shared/nodes';
import { listNodes } from '../../../../../db/repos/nodes';
import { fleetServices, toNodeView } from '../../../../../services/fleet';
import { defineApi } from '../../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../../utils/pagination';

const cursorShape = z.object({ id: z.string().min(1) });

export default defineApi(
	{
		scope: 'organization',
		action: 'node.read',
		rateClass: 'read',
		tags: ['nodes'],
		summary: 'List nodes',
		description:
			'Lists the paired nodes of the organisation in the path in id order, with their host facts and when each last reported.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: nodePageSchema
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape).id;
		const rows = await listNodes(await fleetServices().getDb(), orgId, {
			after,
			count: limit + 1
		});
		const page = toPage(rows, limit, (row) => ({ id: row.id }));
		return { items: page.items.map(toNodeView), nextCursor: page.nextCursor };
	}
);
