import { siteId } from '@contracts/common';
import { z } from 'zod';
import { assignSiteBodySchema, costSiteSchema } from '../../../../../../../shared/cost-centers';
import { ApiError } from '../../../../../../../shared/errors';
import { assignSite, costCenterServices } from '../../../../../../services/cost-centers';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'cost-center.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Assign a site to a cost center',
		description:
			'Sets the one cost center a site bills to, or clears it. The technical and business owner names are kept on the site, and an omitted name is left as it was.',
		params: z.object({ orgId: z.string().min(1), siteId }),
		body: assignSiteBodySchema,
		response: costSiteSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return assignSite(costCenterServices(), orgId, params.siteId, body);
	}
);
