import { z } from 'zod';
import { departmentMemberListSchema } from '../../../../../../../../shared/departments';
import {
	departmentServices,
	listMembersOf,
	targetOf
} from '../../../../../../../services/departments';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'department.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List department members',
		description: 'Lists the people with a role in the department and the role each one holds.',
		params: z.object({ orgId: z.string().min(1), deptId: z.string().min(1).max(64) }),
		response: departmentMemberListSchema
	},
	({ resource, params }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		return listMembersOf(departmentServices(), orgId, departmentId);
	}
);
