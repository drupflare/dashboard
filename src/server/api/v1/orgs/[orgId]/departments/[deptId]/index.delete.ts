import { z } from 'zod';
import {
	actorOf,
	departmentServices,
	removeDepartment,
	targetOf
} from '../../../../../../services/departments';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'department.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Delete a department',
		description:
			'Deletes a department and its member roles. It is refused while the department still holds sites or other departments. Only an organization owner or admin can delete one.',
		params: z.object({ orgId: z.string().min(1), deptId: z.string().min(1).max(64) }),
		successStatus: 204
	},
	async ({ principal, resource, params, facts }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		await removeDepartment(
			departmentServices(),
			orgId,
			actorOf(principal, facts),
			departmentId
		);
	}
);
