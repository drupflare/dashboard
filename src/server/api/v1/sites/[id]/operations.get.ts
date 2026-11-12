import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { failedStepError, failedStepId, failureReason } from '../../../../../shared/operation-copy';
import { listOperationsForSite } from '../../../../db/repos/operations';
import { getReadySite } from '../../../../db/repos/sites';
import { siteServices } from '../../../../services/sites';
import { defineApi } from '../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../utils/pagination';

const cursorShape = z.object({ createdAt: z.number().int().nonnegative(), id: z.string().min(1) });

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['operations'],
		summary: 'List the operations of a site',
		description: 'Lists the operations of one site, newest first, in pages of up to 100.',
		params: z.object({ id: siteId }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({
			items: z.array(operationSchema.extend({ reason: z.string().nullable() })),
			nextCursor: z.string().nullable()
		})
	},
	async ({ resource, query }) => {
		const { orgId, siteId: id } = resource;
		if (!orgId || !id) throw new ApiError('not_found', 'Not found');
		const db = await siteServices().getDb();
		if (!(await getReadySite(db, orgId, id))) throw new ApiError('not_found', 'Not found');
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape);
		const rows = await listOperationsForSite(db, orgId, id, {
			after,
			count: limit + 1
		});
		const page = toPage(rows, limit, (row) => ({
			createdAt: Date.parse(row.operation.createdAt),
			id: row.operation.id
		}));
		const items = page.items.map(({ operation }) => ({
			...operation,
			reason: failureReason({
				type: operation.type,
				status: operation.status,
				failedStep: failedStepId(operation.steps),
				failedError: failedStepError(operation.steps)
			})
		}));
		return { items, nextCursor: page.nextCursor };
	}
);
