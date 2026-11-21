import { z } from 'zod';
import { MONTH } from '../../../../../../shared/cost-centers';
import { ApiError } from '../../../../../../shared/errors';
import { currentMonth } from '../../../../../domain/cost-centers';
import { costCenterServices, costReportCsv } from '../../../../../services/cost-centers';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'cost-center.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Download the monthly cost report as CSV',
		description:
			'Streams the cost report of one month as CSV, one row per cost center and a central total. Text cells that start with a formula character are prefixed with an apostrophe.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			month: z.string().regex(MONTH).optional(),
			amountCents: z
				.string()
				.regex(/^\d{1,12}$/)
				.optional()
		})
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const deps = costCenterServices();
		const month = query.month ?? currentMonth(deps.now());
		const csv = await costReportCsv(deps, orgId, {
			month,
			amountCents: query.amountCents === undefined ? null : Number(query.amountCents)
		});
		return new Response(csv, {
			status: 200,
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="cost-centers-${month}.csv"`
			}
		});
	}
);
