import { siteId } from '@contracts/common';
import { z } from 'zod';
import { budgetBodySchema, budgetWriteReplySchema } from '../../../../../../../shared/budgets';
import { ApiError } from '../../../../../../../shared/errors';
import { stepUpFresh, type Principal } from '../../../../../../domain/authorize';
import { budgetServices, setSiteBudget } from '../../../../../../services/budgets';
import { principalActor } from '../../../../../../services/owner-tokens';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.budget.manage',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Set the spend budget of a site',
		description:
			'Sets the budget of one site as a percent of its monthly allowance. It cannot be higher than the organisation budget. Lowering it, or switching from alert to block, needs the billing permission. Raising it, or switching from block to alert, also needs a fresh sign-in. Every change is audited with the old and new values.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: budgetBodySchema,
		response: budgetWriteReplySchema
	},
	async ({ principal, resource, params, body, facts }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return setSiteBudget(budgetServices(), {
			orgId,
			siteId: resolvedSite,
			actor: principalActor(principal),
			fresh: facts !== null && stepUpFresh(principal as Principal, facts),
			change: body
		});
	}
);
