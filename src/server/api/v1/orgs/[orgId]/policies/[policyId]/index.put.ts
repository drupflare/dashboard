import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { policyGroupBodySchema, policyGroupViewSchema } from '../../../../../../../shared/policies';
import { actorOf } from '../../../../../../services/departments';
import { policyServices, updatePolicy } from '../../../../../../services/policies';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'policy.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Update a policy group',
		description:
			'Replaces the name and rules of a policy group. The change applies to everything the group is assigned to from the next request.',
		params: z.object({ orgId: z.string().min(1), policyId: z.string().min(1).max(64) }),
		body: policyGroupBodySchema,
		response: policyGroupViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return updatePolicy(
			policyServices(),
			orgId,
			actorOf(principal, facts),
			params.policyId,
			body
		);
	}
);
