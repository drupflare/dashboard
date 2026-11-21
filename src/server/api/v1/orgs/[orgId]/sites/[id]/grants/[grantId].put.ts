import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { siteGrantUpdateSchema, siteGrantViewSchema } from '../../../../../../../../shared/members';
import { userIdOf } from '../../../../../../../services/members';
import { changeGrant, siteGrantServices } from '../../../../../../../services/site-grants';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.grant.manage',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Change a site role',
		description:
			'Changes the role or the expiry of one collaborator on this site. The change applies from the next request the person makes.',
		params: z.object({
			orgId: z.string().min(1),
			id: siteId,
			grantId: z.string().min(1).max(64)
		}),
		body: siteGrantUpdateSchema,
		response: siteGrantViewSchema
	},
	({ principal, resource, params, body }) => {
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
		return changeGrant(
			siteGrantServices(),
			orgId,
			resolved,
			{ principal, userId: userIdOf(principal) },
			params.grantId,
			body
		);
	}
);
