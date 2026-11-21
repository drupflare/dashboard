import { siteId } from '@contracts/common';
import { z } from 'zod';
import { transferViewSchema } from '../../../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../../../shared/errors';
import { actorOf } from '../../../../../../../../services/delegations';
import { cancelSiteTransfer, transferServices } from '../../../../../../../../services/transfers';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.transfer',
		rateClass: 'write',
		tags: ['transfers'],
		summary: 'Cancel a site transfer',
		description:
			'Withdraws a proposed transfer while the receiving organisation has not answered. Once it has answered, the transfer cannot be cancelled.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			transferId: z.string().min(1).max(64)
		}),
		body: z.strictObject({}),
		response: transferViewSchema
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return cancelSiteTransfer(
			transferServices(),
			orgId,
			resource.siteId as string,
			actorOf(principal),
			params.transferId
		);
	}
);
