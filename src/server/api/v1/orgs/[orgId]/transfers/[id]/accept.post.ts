import { z } from 'zod';
import { transferViewSchema } from '../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../shared/errors';
import { actorOf } from '../../../../../../services/delegations';
import { acceptSiteTransfer, transferServices } from '../../../../../../services/transfers';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'transfer.accept',
		rateClass: 'write',
		tags: ['transfers'],
		summary: 'Accept a site transfer',
		description:
			'Accepts a site proposed to this organisation. The receiving organisation must have room for another site on its plan, and the answer names the limit when it has none.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: transferViewSchema
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return acceptSiteTransfer(transferServices(), orgId, actorOf(principal), params.id);
	}
);
