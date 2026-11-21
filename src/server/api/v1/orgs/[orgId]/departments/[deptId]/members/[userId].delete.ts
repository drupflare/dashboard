import { z } from 'zod';
import {
	actorOf,
	departmentServices,
	removeDepartmentMemberOf,
	targetOf
} from '../../../../../../../services/departments';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'member.remove',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Remove a department member',
		description:
			'Takes a person out of the department. They stay in the organization. You cannot remove a role that carries something you do not hold yourself.',
		params: z.object({
			orgId: z.string().min(1),
			deptId: z.string().min(1).max(64),
			userId: z.string().min(1).max(64)
		}),
		successStatus: 204
	},
	async ({ principal, resource, params, facts }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		await removeDepartmentMemberOf(
			departmentServices(),
			orgId,
			actorOf(principal, facts),
			departmentId,
			params.userId
		);
	}
);
