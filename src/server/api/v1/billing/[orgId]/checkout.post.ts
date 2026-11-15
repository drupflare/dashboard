import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { INTERVALS } from '../../../../../shared/plans';
import { billingServices, isBillingAdmin, startCheckout } from '../../../../services/billing';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'billing.manage',
		rateClass: 'write',
		tags: ['billing'],
		summary: 'Start a checkout',
		description:
			'Opens a hosted checkout for a managed plan. Needs a signed-in session and refuses API keys. Plans whose price has not been reviewed answer 404. An organisation with no billing contact, name or country answers 422 until it saves them. An organisation whose running subscription holds add-ons alone gets the plan added to it and the answer is applied.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.object({ plan: z.string().min(1).max(64), interval: z.enum(INTERVALS) }),
		response: z.union([z.object({ url: z.url() }), z.object({ applied: z.literal(true) })])
	},
	({ params, body, principal, facts, resource, idempotencyKey }) => {
		// the organisation comes from the authorized resource, never from the path
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return startCheckout(billingServices(), {
			orgId,
			planId: body.plan,
			interval: body.interval,
			admin: isBillingAdmin(facts),
			principal,
			idempotencyKey: idempotencyKey ?? crypto.randomUUID()
		});
	}
);
