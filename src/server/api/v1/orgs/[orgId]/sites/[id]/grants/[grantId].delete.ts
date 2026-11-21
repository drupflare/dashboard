import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { userIdOf } from '../../../../../../../services/members';
import { revokeGrant, siteGrantServices } from '../../../../../../../services/site-grants';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.grant.manage',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Remove a site collaborator',
		description:
			"Ends one person's role on this site. Revoking a role that already ended changes nothing.",
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			grantId: z.string().min(1).max(64)
		}),
		successStatus: 204
	},
	async ({ principal, resource, params }) => {
		const { orgId, siteId: resolved } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolved === undefined ||
			orgId !== params.orgId ||
			resolved !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		await revokeGrant(
			siteGrantServices(),
			orgId,
			resolved,
			{ principal, userId: userIdOf(principal) },
			params.grantId
		);
	}
);
