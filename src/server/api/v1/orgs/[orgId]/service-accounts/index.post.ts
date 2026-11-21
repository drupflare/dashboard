import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import {
	serviceAccountCreateBodySchema,
	serviceAccountViewSchema
} from '../../../../../../shared/service-accounts';
import { governanceActor, governanceServices } from '../../../../../services/governance';
import { createServiceAccount } from '../../../../../services/service-accounts';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'service-account.manage',
		rateClass: 'write',
		tags: ['service-accounts'],
		summary: 'Create a service account',
		description:
			'Creates a service account that has no sign-in and holds only keys. It needs a named owner who belongs to the organization and an expiry of at most one year. Its keys never carry more than the owner holds.',
		params: z.object({ orgId: z.string().min(1) }),
		body: serviceAccountCreateBodySchema,
		response: serviceAccountViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createServiceAccount(
			governanceServices(),
			orgId,
			governanceActor(principal, facts),
			body
		);
	}
);
