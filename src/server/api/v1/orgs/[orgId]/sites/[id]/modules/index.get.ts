import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../../shared/errors';
import { moduleListItemSchema, moduleQuerySchema } from '../../../../../../../../shared/modules';
import { moduleServices, searchSiteModules } from '../../../../../../../services/modules';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.module.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Search the modules for a site',
		description:
			'Searches the module list by machine name and label, filtered by state and kind. Each row carries its state and reason. installed is null when the site cannot say whether a module is installed. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		query: moduleQuerySchema,
		response: z.object({ items: z.array(moduleListItemSchema) })
	},
	async ({ principal, resource, params, query }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return searchSiteModules(moduleServices(), { orgId, siteId: resolvedSite, query });
	}
);
