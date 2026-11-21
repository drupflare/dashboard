import { siteId } from '@contracts/common';
import { operationSchema } from '@contracts/operations';
import { z } from 'zod';
import { setSiteSuspension } from '../../../../../services/site-suspension';
import { supportServices } from '../../../../../services/support';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'admin',
		action: 'admin.site.unsuspend',
		rateClass: 'write',
		tags: ['admin'],
		summary: 'Lift the suspension on a site',
		description:
			'Makes a suspended site active again through the site authority. Needs step-up. The owners are told by email and both audit logs record it. Only a suspension lifts: a revoked site stays revoked.',
		params: z.object({ id: siteId }),
		response: z.object({ operation: operationSchema, ownersNotified: z.number() }),
		successStatus: 202
	},
	async ({ params, principal, idempotencyKey, requestId }) => {
		if (principal === null) throw new Error('an admin route always has a principal');
		const result = await setSiteSuspension(supportServices(), {
			siteId: params.id,
			state: 'active',
			reason: 'lift',
			principal,
			key: idempotencyKey ?? requestId
		});
		return { operation: result.operation.operation, ownersNotified: result.notified };
	}
);
