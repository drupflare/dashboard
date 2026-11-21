import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { serviceAccountKeyListSchema } from '../../../../../../../../shared/service-accounts';
import { governanceActor, governanceServices } from '../../../../../../../services/governance';
import { listKeysOfAccount } from '../../../../../../../services/service-accounts';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'service-account.manage',
		rateClass: 'read',
		tags: ['service-accounts'],
		summary: 'List the keys of a service account',
		description:
			'Lists every key issued to the service account, newest first, with the permissions it carries and when it last worked.',
		params: z.object({ orgId: z.string().min(1), saId: z.string().min(1).max(64) }),
		response: serviceAccountKeyListSchema
	},
	({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return listKeysOfAccount(
			governanceServices(),
			orgId,
			governanceActor(principal, facts),
			params.saId
		);
	}
);
