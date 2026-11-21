import { z } from 'zod';
import {
	departmentMemberBodySchema,
	departmentMemberViewSchema
} from '../../../../../../../../shared/departments';
import {
	actorOf,
	addDepartmentMember,
	departmentServices,
	targetOf
} from '../../../../../../../services/departments';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.invite',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Add a department member',
		description:
			'Gives a member of the organization a role in the department. The role covers the departments inside it too. You can give only a role that carries nothing you do not hold yourself.',
		params: z.object({ orgId: z.string().min(1), deptId: z.string().min(1).max(64) }),
		body: departmentMemberBodySchema,
		response: departmentMemberViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, facts }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		return addDepartmentMember(
			departmentServices(),
			orgId,
			actorOf(principal, facts),
			departmentId,
			body
		);
	}
);
