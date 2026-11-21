import { z } from 'zod';
import { budgetReplySchema } from '../../../../../shared/budgets';
import { ApiError } from '../../../../../shared/errors';
import { budgetServices, readOrgBudget } from '../../../../services/budgets';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'billing.manage',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read the spend budget',
		description:
			'Reads the organisation spend budget: the percent of the monthly allowance, whether it blocks or only alerts, the allowance, the views counted so far (a lower bound), the current state and the alerts already sent this month. A free organisation has no budget and the answer is not_applicable. The enforcement flag says whether blocking is on or still in shadow mode, where it logs and alerts but blocks nothing.',
		params: z.object({ orgId: z.string().min(1) }),
		response: budgetReplySchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return readOrgBudget(budgetServices(), orgId);
	}
);
