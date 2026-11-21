import { z } from 'zod';
import { departmentViewSchema, quotaBodySchema } from '../../../../../../../shared/departments';
import {
	actorOf,
	departmentServices,
	setQuota,
	targetOf
} from '../../../../../../services/departments';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'department.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Set the Site Limit',
		description:
			'Sets how many sites a department can hold, counting the departments inside it, or removes the limit with null. Only an organization owner or admin can set it. A limit below the current count stops new sites and removes none.',
		params: z.object({ orgId: z.string().min(1), deptId: z.string().min(1).max(64) }),
		body: quotaBodySchema,
		response: departmentViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const { orgId, departmentId } = targetOf(resource, params);
		return setQuota(
			departmentServices(),
			orgId,
			actorOf(principal, facts),
			departmentId,
			body.siteQuota
		);
	}
);
