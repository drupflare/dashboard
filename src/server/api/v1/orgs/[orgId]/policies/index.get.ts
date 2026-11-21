import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { policyListSchema } from '../../../../../../shared/policies';
import { listPolicies, policyServices } from '../../../../../services/policies';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'policy.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List policy groups',
		description:
			'Lists the policy groups of the organization with their rules and what each one is assigned to, and the default group picked for each data classification label.',
		params: z.object({ orgId: z.string().min(1) }),
		response: policyListSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return listPolicies(policyServices(), orgId);
	}
);
