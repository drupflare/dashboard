import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { supportGrantView } from '../../../../../../shared/support';
import { listOrgGrants, supportServices } from '../../../../../services/support';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'support-grant.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List support access grants',
		description:
			'Lists the times you let Drupflare support into this organization, newest first, with whether each one is still live.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({ items: z.array(supportGrantView) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		return { items: await listOrgGrants(supportServices(), orgId) };
	}
);
