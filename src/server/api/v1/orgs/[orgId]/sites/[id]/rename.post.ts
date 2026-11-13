import { siteId } from '@contracts/common';
import { siteSchema } from '@contracts/sites';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { renameBoxSite } from '../../../../../../services/box-sites';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.update',
		rateClass: 'write',
		tags: ['sites'],
		summary: 'Rename a site found on a box',
		description:
			'Changes the name of a site a box reported and the dashboard listed. It is the only kind of site that can be renamed, since the name of any other site is part of its address. The name is 1 to 100 characters and no other live site of the organisation holds it.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		body: z.strictObject({ name: z.string().max(256) }),
		response: siteSchema
	},
	async ({ principal, resource, params, body }) => {
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
		return renameBoxSite(await siteServices().getDb(), {
			orgId,
			siteId: resolved,
			name: body.name
		});
	}
);
