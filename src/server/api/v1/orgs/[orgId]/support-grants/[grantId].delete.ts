import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { revokeGrant, supportServices } from '../../../../../services/support';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'support-grant.revoke',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Revoke support access',
		description:
			'Ends a support access grant now. Support loses access on the next request. Revoking a grant that already ended does nothing.',
		params: z.object({ orgId: z.string().min(1), grantId: z.string().min(1).max(64) }),
		successStatus: 204
	},
	async ({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		if (principal === null) throw new Error('an organization route always has a principal');
		await revokeGrant(supportServices(), { orgId, id: params.grantId, principal });
	}
);
