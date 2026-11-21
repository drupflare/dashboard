import { z } from 'zod';
import { costCenterViewSchema } from '../../../../../../shared/cost-centers';
import { ApiError } from '../../../../../../shared/errors';
import { costCenterServices, listCostCenterViews } from '../../../../../services/cost-centers';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'cost-center.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List the cost centers of an organisation',
		description:
			'Lists the cost centers of the organisation, by code. A cost center holds billing only and never grants access.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({ items: z.array(costCenterViewSchema) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return { items: await listCostCenterViews(costCenterServices(), orgId) };
	}
);
