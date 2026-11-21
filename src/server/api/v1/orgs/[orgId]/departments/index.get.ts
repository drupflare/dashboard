import { z } from 'zod';
import { departmentListSchema } from '../../../../../../shared/departments';
import { ApiError } from '../../../../../../shared/errors';
import {
	actorOf,
	departmentServices,
	listDepartmentViews
} from '../../../../../services/departments';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'department.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List departments',
		description:
			'Lists every division and department of the organization with its parent, Site Limit, site counts and member count, and whether you can manage each one. The count for a department includes the departments inside it.',
		params: z.object({ orgId: z.string().min(1) }),
		response: departmentListSchema
	},
	({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return listDepartmentViews(departmentServices(), orgId, actorOf(principal, facts));
	}
);
