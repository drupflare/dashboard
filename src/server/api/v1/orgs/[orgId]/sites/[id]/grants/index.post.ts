import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { siteGrantBodySchema, siteGrantViewSchema } from '../../../../../../../../shared/members';
import { userIdOf } from '../../../../../../../services/members';
import { grantSite, siteGrantServices } from '../../../../../../../services/site-grants';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.grant.manage',
		rateClass: 'write',
		tags: ['members'],
		summary: 'Give a person a site role',
		description:
			'Gives an existing account a role on this site: site admin, maintainer or viewer, with an optional expiry. The person must already have an account. Someone who already has a role on the site is changed instead.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: siteGrantBodySchema,
		response: siteGrantViewSchema,
		successStatus: 201
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
		return grantSite(
			siteGrantServices(),
			orgId,
			resolved,
			{
				principal,
				userId: userIdOf(principal)
			},
			body
		);
	}
);
