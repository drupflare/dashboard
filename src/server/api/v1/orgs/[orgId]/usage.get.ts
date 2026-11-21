import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { MONTH_PATTERN, orgUsageSchema, type OrgUsage } from '../../../../../shared/usage';
import { currentMonth } from '../../../../domain/cost-centers';
import { orgMonthUsage, usageServices } from '../../../../services/usage';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'usage.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read the views of an organisation for one month',
		description:
			'Shows the views of each site and of the whole organisation for one UTC month, per day, with the accounting state of each day. A started hour with no stored row is unaccounted, never zero.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({ month: z.string().regex(MONTH_PATTERN).optional() }),
		response: orgUsageSchema
	},
	async ({ resource, params, query }): Promise<OrgUsage> => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const deps = usageServices();
		return orgMonthUsage(deps, orgId, query.month ?? currentMonth(deps.now()));
	}
);
