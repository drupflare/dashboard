import { z } from 'zod';
import { placementListSchema } from '../../../../../../shared/departments';
import { ApiError } from '../../../../../../shared/errors';
import { departmentServices, listSitePlacements } from '../../../../../services/departments';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'department.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List where sites sit',
		description:
			'Lists the organization sites with the department each one sits in, or none for a site at the organization level.',
		params: z.object({ orgId: z.string().min(1) }),
		response: placementListSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return listSitePlacements(departmentServices(), orgId);
	}
);
