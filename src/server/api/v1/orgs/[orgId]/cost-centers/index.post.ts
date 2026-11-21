import { z } from 'zod';
import { costCenterBodySchema, costCenterViewSchema } from '../../../../../../shared/cost-centers';
import { ApiError } from '../../../../../../shared/errors';
import { costCenterServices, createCostCenter } from '../../../../../services/cost-centers';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'cost-center.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Create a cost center',
		description:
			'Adds a cost center. The code is unique within the organisation and is the name finance knows the center by.',
		params: z.object({ orgId: z.string().min(1) }),
		body: costCenterBodySchema,
		response: costCenterViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createCostCenter(costCenterServices(), orgId, body);
	}
);
