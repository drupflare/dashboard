import { z } from 'zod';
import { costSiteSchema } from '../../../../../../../shared/cost-centers';
import { ApiError } from '../../../../../../../shared/errors';
import { costCenterServices, listCostSites } from '../../../../../../services/cost-centers';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'cost-center.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List sites and their cost centers',
		description:
			'Lists the live sites of the organisation with the cost center each one bills to.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({ items: z.array(costSiteSchema) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return { items: await listCostSites(costCenterServices(), orgId) };
	}
);
