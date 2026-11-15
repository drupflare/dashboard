import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import {
	accessServices,
	syncedSchema,
	syncSiteAccess
} from '../../../../../../../services/access-rules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.access.manage',
		rateClass: 'write',
		tags: ['gate'],
		summary: 'Apply the saved access rules to a site again',
		description:
			'Starts the change that writes the saved access rules to the site. Use it when a rule is saved but the site has not picked it up. The response names the operation to follow.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		response: syncedSchema
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
		return syncSiteAccess(accessServices(), orgId, resolved);
	}
);
