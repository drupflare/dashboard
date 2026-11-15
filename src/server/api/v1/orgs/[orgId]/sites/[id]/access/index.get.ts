import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	accessServices,
	accessViewSchema,
	readSiteAccess
} from '../../../../../../../services/access-rules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.access.read',
		rateClass: 'read',
		tags: ['gate'],
		summary: 'Read who can open a site',
		description:
			'Lists the active access rules of the site in the path, which access types the plan includes, and the invited address limit. Passwords and link tokens are never returned.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: accessViewSchema
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
		return readSiteAccess(accessServices(), { orgId, siteId: resolved });
	}
);
