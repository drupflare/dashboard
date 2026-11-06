import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { billingServices, startPortal } from '../../../../services/billing';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'billing.portal',
		rateClass: 'write',
		tags: ['billing'],
		summary: 'Open the billing portal',
		description:
			'Opens the hosted portal where the organisation changes its card, reads invoices or cancels. Needs a signed-in session and refuses API keys.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({ url: z.url() })
	},
	({ params, principal, resource }) => {
		// the organisation comes from the authorized resource, never from the path
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return startPortal(billingServices(), { orgId, principal });
	}
);
