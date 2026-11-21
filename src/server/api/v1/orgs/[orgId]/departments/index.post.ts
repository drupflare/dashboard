import { z } from 'zod';
import {
	departmentCreateBodySchema,
	departmentViewSchema
} from '../../../../../../shared/departments';
import { ApiError } from '../../../../../../shared/errors';
import { actorOf, createDepartment, departmentServices } from '../../../../../services/departments';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'department.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Create a department',
		description:
			'Adds a division or department, optionally inside another. Only an organization owner or admin can add one. Departments go four levels deep at most, and a division cannot sit inside a department.',
		params: z.object({ orgId: z.string().min(1) }),
		body: departmentCreateBodySchema,
		response: departmentViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return createDepartment(departmentServices(), orgId, actorOf(principal, facts), body);
	}
);
