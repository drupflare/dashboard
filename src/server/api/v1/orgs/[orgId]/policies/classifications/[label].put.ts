import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import {
	CLASSIFICATIONS,
	classificationNameBodySchema,
	policyListSchema
} from '../../../../../../../shared/policies';
import { actorOf } from '../../../../../../services/departments';
import { policyServices, setClassificationDisplayName } from '../../../../../../services/policies';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'policy.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Name a classification label',
		description:
			'Sets what the organization calls one of the four data classification labels, such as its own level names, or clears the name with null.',
		params: z.object({ orgId: z.string().min(1), label: z.enum(CLASSIFICATIONS) }),
		body: classificationNameBodySchema,
		response: policyListSchema
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return setClassificationDisplayName(
			policyServices(),
			orgId,
			actorOf(principal, facts),
			params.label,
			body.displayName
		);
	}
);
