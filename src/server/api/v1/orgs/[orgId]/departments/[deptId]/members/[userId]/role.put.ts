import { z } from 'zod';
import {
	departmentMemberViewSchema,
	departmentRoleBodySchema
} from '../../../../../../../../../shared/departments';
import {
	actorOf,
	changeDepartmentMemberRole,
	departmentServices,
	targetOf
} from '../../../../../../../../services/departments';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.update',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Change a department role',
		description:
			'Changes the role a person holds in the department. You can change a role only when both the current and the new role carry nothing you do not hold yourself.',
		params: z.object({
			orgId: z.string().min(1),
			deptId: z.string().min(1).max(64),
			userId: z.string().min(1).max(64)
		}),
		body: departmentRoleBodySchema,
		response: departmentMemberViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		return changeDepartmentMemberRole(
			departmentServices(),
			orgId,
			actorOf(principal, facts),
			departmentId,
			params.userId,
			body.role
		);
	}
);
