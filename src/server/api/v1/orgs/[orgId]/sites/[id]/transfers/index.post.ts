import { siteId } from '@contracts/common';
import { z } from 'zod';
import { transferCreateSchema, transferViewSchema } from '../../../../../../../../shared/agency';
import { ApiError } from '../../../../../../../../shared/errors';
import { actorOf } from '../../../../../../../services/delegations';
import { proposeSiteTransfer, transferServices } from '../../../../../../../services/transfers';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.transfer',
		rateClass: 'write',
		tags: ['transfers'],
		summary: 'Propose a site transfer',
		description:
			'Proposes that the site moves to another organisation. The receiving organisation answers within 14 days, and the site stays here until it accepts. Ownership, billing and any agency access move as separate steps. Keeping an agency maintainer access needs that access to be active for this site.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: transferCreateSchema,
		response: transferViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return proposeSiteTransfer(
			transferServices(),
			orgId,
			resource.siteId as string,
			actorOf(principal),
			body
		);
	}
);
