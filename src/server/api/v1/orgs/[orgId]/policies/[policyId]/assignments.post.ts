import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { assignmentSchema, policyGroupViewSchema } from '../../../../../../../shared/policies';
import { actorOf } from '../../../../../../services/departments';
import { assignPolicy, policyServices } from '../../../../../../services/policies';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'policy.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Assign a policy group',
		description:
			'Applies a policy group to the organization, a department, a site or a data classification label. Everything below a department inherits it. A label has one default group, so picking a new one replaces the old one.',
		params: z.object({ orgId: z.string().min(1), policyId: z.string().min(1).max(64) }),
		body: assignmentSchema,
		response: policyGroupViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return assignPolicy(
			policyServices(),
			orgId,
			actorOf(principal, facts),
			params.policyId,
			body
		);
	}
);
