import { z } from 'zod';
import { budgetBodySchema, budgetWriteReplySchema } from '../../../../../shared/budgets';
import { ApiError } from '../../../../../shared/errors';
import { stepUpFresh, type Principal } from '../../../../domain/authorize';
import { budgetServices, setOrgBudget } from '../../../../services/budgets';
import { principalActor } from '../../../../services/owner-tokens';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'billing.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Set the spend budget',
		description:
			'Sets the organisation spend budget. Lowering it, or switching from alert to block, needs the billing permission. Raising it, or switching from block to alert, also needs a fresh sign-in. Every change is audited with the old and new values. The response says how soon the change reaches the sites.',
		params: z.object({ orgId: z.string().min(1) }),
		body: budgetBodySchema,
		response: budgetWriteReplySchema
	},
	async ({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return setOrgBudget(budgetServices(), {
			orgId,
			actor: principalActor(principal),
			fresh: facts !== null && stepUpFresh(principal as Principal, facts),
			change: body
		});
	}
);
