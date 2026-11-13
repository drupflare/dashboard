import { ESTATE_LIMITS, ROW_CLASSES, ROW_STATES } from '@contracts/estate';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { ASSESSMENT_ID, rowViewSchema } from '../../../../../../../shared/estate-view';
import { readRows } from '../../../../../../services/estate';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';
import { decodeCursor, resolveLimit, toPage } from '../../../../../../utils/pagination';

const cursorShape = z.object({ number: z.int().nonnegative() });

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.read',
		rateClass: 'read',
		tags: ['assessments'],
		summary: 'List the rows of an assessment',
		description:
			'Lists the sites of an assessment in row order, with the class, state and findings of each. Filter by class, by state, or by text in the hostname.',
		params: z.object({ orgId: z.string().min(1), id: z.string().regex(ASSESSMENT_ID) }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional(),
			class: z.enum(ROW_CLASSES).optional(),
			state: z.enum(ROW_STATES).optional(),
			q: z.string().max(ESTATE_LIMITS.hostnameChars).optional()
		}),
		response: z.object({ items: z.array(rowViewSchema), nextCursor: z.string().nullable() })
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const limit = resolveLimit(query.limit === undefined ? undefined : Number(query.limit));
		const after =
			query.cursor === undefined ? 0 : decodeCursor(query.cursor, cursorShape).number;
		const rows = await readRows(siteServices(), orgId, params.id, {
			after,
			count: limit + 1,
			filter: { class: query.class, state: query.state, text: query.q }
		});
		return toPage(rows, limit, (row) => ({ number: row.number }));
	}
);
