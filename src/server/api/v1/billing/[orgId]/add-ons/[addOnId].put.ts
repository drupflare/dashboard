import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { billingServices } from '../../../../../services/billing';
import { MAX_ADD_ON_QUANTITY, setAddOnQuantity } from '../../../../../services/billing-addons';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'billing.manage',
		rateClass: 'write',
		tags: ['billing'],
		summary: 'Change an add-on quantity',
		description:
			'Sets how many of an add-on the organisation holds on its running subscription; 0 removes it. Needs a signed-in session and refuses API keys. An add-on the organisation does not hold answers 404. The quantity changes only when the payment provider confirms it.',
		params: z.object({ orgId: z.string().min(1), addOnId: z.string().min(1).max(64) }),
		body: z.object({ quantity: z.number().int().min(0).max(MAX_ADD_ON_QUANTITY) }),
		response: z.object({ applied: z.literal(true) })
	},
	({ params, body, principal, resource, idempotencyKey }) => {
		// the organisation comes from the authorized resource, never from the path
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return setAddOnQuantity(billingServices(), {
			orgId,
			addOn: params.addOnId,
			quantity: body.quantity,
			principal,
			idempotencyKey: idempotencyKey ?? crypto.randomUUID()
		});
	}
);
