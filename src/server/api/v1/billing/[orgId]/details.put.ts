import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { billingServices, saveBillingDetails } from '../../../../services/billing';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'billing.manage',
		rateClass: 'write',
		tags: ['billing'],
		summary: 'Save the billing details',
		description:
			'Saves the billing contact name and email and the billing country that a checkout or an add-on purchase needs. Needs a signed-in session and refuses API keys. The checkout page asks for the full address and keeps these in step.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.object({
			name: z.string().min(1).max(200),
			email: z.string().min(3).max(320),
			country: z.string().length(2)
		}),
		response: z.object({ saved: z.literal(true) })
	},
	({ params, body, principal, resource }) => {
		// the organisation comes from the authorized resource, never from the path
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return saveBillingDetails(billingServices(), { orgId, principal, ...body });
	}
);
