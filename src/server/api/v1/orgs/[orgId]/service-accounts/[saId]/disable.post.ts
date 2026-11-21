import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { serviceAccountViewSchema } from '../../../../../../../shared/service-accounts';
import { governanceActor, governanceServices } from '../../../../../../services/governance';
import { disableServiceAccount } from '../../../../../../services/service-accounts';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'service-account.manage',
		rateClass: 'write',
		tags: ['service-accounts'],
		summary: 'Disable a service account',
		description:
			'Revokes every key of the service account and turns the account off. Disabling an account that is already off changes nothing.',
		params: z.object({ orgId: z.string().min(1), saId: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: serviceAccountViewSchema
	},
	({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return disableServiceAccount(
			governanceServices(),
			orgId,
			governanceActor(principal, facts),
			params.saId
		);
	}
);
