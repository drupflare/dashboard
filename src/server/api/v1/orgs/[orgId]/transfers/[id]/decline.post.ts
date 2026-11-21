import { z } from 'zod';
import { transferViewSchema } from '../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../shared/errors';
import { actorOf } from '../../../../../../services/delegations';
import { declineSiteTransfer, transferServices } from '../../../../../../services/transfers';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'transfer.decline',
		rateClass: 'write',
		tags: ['transfers'],
		summary: 'Decline a site transfer',
		description:
			'Declines a site proposed to this organisation. The site stays with the proposing organisation, and a declined transfer cannot be accepted later.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: transferViewSchema
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return declineSiteTransfer(transferServices(), orgId, actorOf(principal), params.id);
	}
);
