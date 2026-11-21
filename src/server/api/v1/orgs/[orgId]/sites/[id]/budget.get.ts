import { siteId } from '@contracts/common';
import { z } from 'zod';
import { budgetReplySchema } from '../../../../../../../shared/budgets';
import { ApiError } from '../../../../../../../shared/errors';
import { budgetServices, readSiteBudget } from '../../../../../../services/budgets';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.budget.manage',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the spend budget of a site',
		description:
			'Reads the budget that applies to one site. Under a pooled allowance a site has a default share until the owner sets one, and ownerSet says which it is. A site without a budget of its own is governed by the organisation budget and reads null percent. A free organisation answers not_applicable.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: budgetReplySchema
	},
	async ({ resource, params }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return readSiteBudget(budgetServices(), orgId, resolvedSite);
	}
);
