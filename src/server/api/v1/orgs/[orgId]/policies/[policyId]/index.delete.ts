import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { actorOf } from '../../../../../../services/departments';
import { deletePolicy, policyServices } from '../../../../../../services/policies';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'policy.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Delete a policy group',
		description:
			'Deletes a policy group. It is refused while the group is still assigned to the organization, a department, a site or a classification label.',
		params: z.object({ orgId: z.string().min(1), policyId: z.string().min(1).max(64) }),
		successStatus: 204
	},
	async ({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		await deletePolicy(policyServices(), orgId, actorOf(principal, facts), params.policyId);
	}
);
