import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { siteGrantViewSchema } from '../../../../../../../../shared/members';
import { listGrants, siteGrantServices } from '../../../../../../../services/site-grants';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.access.read',
		rateClass: 'read',
		tags: ['members'],
		summary: 'List site collaborators',
		description:
			'Lists the people who have a role on this site, with the role and any expiry. A grant that was revoked does not appear.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: z.array(siteGrantViewSchema)
	},
	({ resource, params }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return listGrants(siteGrantServices(), orgId, resolved);
	}
);
