import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { INTERVALS } from '../../../../../shared/plans';
import { billingServices, isBillingAdmin } from '../../../../services/billing';
import { MAX_ADD_ON_QUANTITY, startAddOnPurchase } from '../../../../services/billing-addons';
import { defineApi } from '../../../../utils/define-api';

const addOn = z.string().min(1).max(64);

export default defineApi(
	{
		scope: 'organization',
		action: 'billing.manage',
		rateClass: 'write',
		tags: ['billing'],
		summary: 'Buy an add-on',
		description:
			'Buys an add-on as a subscription, billed with the plan, or as a one-time pack. Needs a signed-in session and refuses API keys. A subscription add-on on a running subscription changes at once and answers applied; otherwise a hosted checkout opens and the answer is its url. The quantity changes only when the payment provider confirms it. An add-on that does not exist, is not on sale or has an unreviewed price answers 404.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.discriminatedUnion('mode', [
			z.object({
				mode: z.literal('subscription'),
				addOn,
				quantity: z.number().int().min(1).max(MAX_ADD_ON_QUANTITY),
				interval: z.enum(INTERVALS)
			}),
			z.object({ mode: z.literal('pack'), addOn, units: z.number().int().positive() })
		]),
		response: z.union([z.object({ url: z.url() }), z.object({ applied: z.literal(true) })])
	},
	({ params, body, principal, facts, resource, idempotencyKey }) => {
		// the organisation comes from the authorized resource, never from the path
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return startAddOnPurchase(billingServices(), {
			...body,
			orgId,
			admin: isBillingAdmin(facts),
			principal,
			idempotencyKey: idempotencyKey ?? crypto.randomUUID()
		});
	}
);
