import { z } from 'zod';
import {
	costCenterBodySchema,
	costCenterViewSchema
} from '../../../../../../../shared/cost-centers';
import { ApiError } from '../../../../../../../shared/errors';
import { costCenterServices, editCostCenter } from '../../../../../../services/cost-centers';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'cost-center.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Change a cost center',
		description:
			'Replaces the code, name, department and owner contact of a cost center. Sites keep their assignment.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		body: costCenterBodySchema,
		response: costCenterViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return editCostCenter(costCenterServices(), orgId, params.id, body);
	}
);
