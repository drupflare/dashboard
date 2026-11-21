import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { serviceAccountListSchema } from '../../../../../../shared/service-accounts';
import { governanceActor, governanceServices } from '../../../../../services/governance';
import { listServiceAccountViews } from '../../../../../services/service-accounts';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'service-account.manage',
		rateClass: 'read',
		tags: ['service-accounts'],
		summary: 'List service accounts',
		description:
			'Lists the service accounts you can manage in the organization, with the owner, the expiry and when any key last worked. A department admin sees only the accounts in their own department.',
		params: z.object({ orgId: z.string().min(1) }),
		response: serviceAccountListSchema
	},
	async ({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return {
			items: await listServiceAccountViews(
				governanceServices(),
				orgId,
				governanceActor(principal, facts)
			)
		};
	}
);
