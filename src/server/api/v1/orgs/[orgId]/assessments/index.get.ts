import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { assessmentViewSchema } from '../../../../../../shared/estate-view';
import { listAssessmentViews } from '../../../../../services/estate';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../../utils/pagination';

const cursorShape = z.object({ createdAt: z.number(), id: z.string().min(1) });

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.read',
		rateClass: 'read',
		tags: ['assessments'],
		summary: 'List assessments',
		description: 'Lists the estate assessments of the organisation, newest first.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: z.object({
			items: z.array(assessmentViewSchema),
			nextCursor: z.string().nullable()
		})
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const before =
			query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape);
		const { items, records } = await listAssessmentViews(siteServices(), orgId, {
			before,
			count: limit + 1
		});
		const page = toPage(records, limit, (row) => ({ createdAt: row.createdAt, id: row.id }));
		return { items: items.slice(0, limit), nextCursor: page.nextCursor };
	}
);
