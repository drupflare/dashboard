import { z } from 'zod';
import { ApiError } from '../../../../../../../../../shared/errors';
import { ASSIGNMENT_KINDS } from '../../../../../../../../../shared/policies';
import { actorOf } from '../../../../../../../../services/departments';
import { policyServices, unassignPolicy } from '../../../../../../../../services/policies';
import { defineApi } from '../../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'policy.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Unassign a policy group',
		description:
			'Takes a policy group off the organization, a department, a site or a classification label. For the organization, the target is the organization id.',
		params: z.object({
			orgId: z.string().min(1),
			policyId: z.string().min(1).max(64),
			kind: z.enum(ASSIGNMENT_KINDS),
			targetId: z.string().min(1).max(64)
		}),
		successStatus: 204
	},
	async ({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		await unassignPolicy(policyServices(), orgId, actorOf(principal, facts), params.policyId, {
			kind: params.kind,
			targetId: params.targetId
		});
	}
);
