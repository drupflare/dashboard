import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { pilotSitesBodySchema, pilotViewSchema } from '../../../../../../../shared/pilots';
import { pilotServices, setPilotSites } from '../../../../../../services/pilots';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Set the sites of a pilot',
		description:
			'Replaces the list of sites in the pilot. Each site must belong to the organisation.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		body: pilotSitesBodySchema,
		response: pilotViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return setPilotSites(pilotServices(), orgId, params.id, body.siteIds);
	}
);
