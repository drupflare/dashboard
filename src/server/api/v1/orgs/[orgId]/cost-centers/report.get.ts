import { z } from 'zod';
import { MONTH, costReportSchema } from '../../../../../../shared/cost-centers';
import { ApiError } from '../../../../../../shared/errors';
import { currentMonth } from '../../../../../domain/cost-centers';
import { costCenterServices, costReport } from '../../../../../services/cost-centers';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'cost-center.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read the monthly cost report',
		description:
			'Shows the usage of each cost center for one month with its accounting state, an optional allocation of an organisation total by share, a straight-line projection and a central summary. A projection is a line through the views so far, not a forecast.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			month: z.string().regex(MONTH).optional(),
			amountCents: z
				.string()
				.regex(/^\d{1,12}$/)
				.optional()
		}),
		response: costReportSchema
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const deps = costCenterServices();
		return costReport(deps, orgId, {
			month: query.month ?? currentMonth(deps.now()),
			amountCents: query.amountCents === undefined ? null : Number(query.amountCents)
		});
	}
);
