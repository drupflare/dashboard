import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { policyGroupBodySchema, policyGroupViewSchema } from '../../../../../../shared/policies';
import { actorOf } from '../../../../../services/departments';
import { createPolicy, policyServices } from '../../../../../services/policies';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'policy.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Create a policy group',
		description:
			'Adds a policy group with its rules. A group does nothing until it is assigned to the organization, a department, a site or a data classification.',
		params: z.object({ orgId: z.string().min(1) }),
		body: policyGroupBodySchema,
		response: policyGroupViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return createPolicy(policyServices(), orgId, actorOf(principal, facts), body);
	}
);
