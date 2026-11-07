import { siteId } from '@contracts/common';
import { siteSchema } from '@contracts/sites';
import { z } from 'zod';
import { ApiError } from '../../../../../shared/errors';
import { getReadySite, toSite } from '../../../../db/repos/sites';
import { siteServices } from '../../../../services/sites';
import { defineApi } from '../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read a site',
		description:
			'Returns one site of your organisation. A site still being created is not found.',
		params: z.object({ id: siteId }),
		response: siteSchema
	},
	async ({ resource }) => {
		if (!resource.orgId || !resource.siteId) throw new ApiError('not_found', 'Not found');
		const site = await getReadySite(
			await siteServices().getDb(),
			resource.orgId,
			resource.siteId
		);
		if (!site) throw new ApiError('not_found', 'Not found');
		return toSite(site, siteServices().config.releases[site.kind] ?? null);
	}
);
