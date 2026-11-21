import { z } from 'zod';
import {
	departmentUpdateBodySchema,
	departmentViewSchema
} from '../../../../../../../shared/departments';
import {
	actorOf,
	departmentServices,
	editDepartment,
	targetOf
} from '../../../../../../services/departments';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'department.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Rename or move a department',
		description:
			'Renames a department or moves it inside another. A department admin can rename their own department. Moving one in the tree is for organization owners and admins.',
		params: z.object({ orgId: z.string().min(1), deptId: z.string().min(1).max(64) }),
		body: departmentUpdateBodySchema,
		response: departmentViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		return editDepartment(
			departmentServices(),
			orgId,
			actorOf(principal, facts),
			departmentId,
			body
		);
	}
);
