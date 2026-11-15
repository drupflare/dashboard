import { siteId } from '@contracts/common';
import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { settingsViewSchema } from '../../../../../../../shared/site-config/view';
import { permittedActions } from '../../../../../../domain/authorize';
import { readSiteSettings, siteSettingsServices } from '../../../../../../services/site-settings';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'site',
		action: 'site.config.runtime.read',
		rateClass: 'read',
		tags: ['sites'],
		summary: 'Read the settings of a site',
		description:
			'Reads the effective settings of the site in the path with where each value comes from. Only the groups the caller may read are returned. Send fresh=1 to skip the stored copy. A site that does not answer returns the last settings it reported, marked stale, or an empty state. A site of another organisation is not found.',
		params: z.object({ orgId: z.string().min(1), id: siteId }),
		query: z.object({ fresh: z.enum(['0', '1']).optional() }),
		response: settingsViewSchema
	},
	async ({ principal, resource, params, query, facts }) => {
		const { orgId, siteId: resolvedSite } = resource;
		if (
			principal === null ||
			facts === null ||
			orgId === undefined ||
			resolvedSite === undefined ||
			orgId !== params.orgId ||
			resolvedSite !== params.id
		) {
			throw new ApiError('not_found', 'Not found');
		}
		return readSiteSettings(siteSettingsServices(), {
			orgId,
			siteId: resolvedSite,
			principal,
			permitted: permittedActions({ principal, resource, facts }),
			owner: facts.membership?.role === 'owner',
			fresh: query.fresh === '1'
		});
	}
);
