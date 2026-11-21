import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { pilotViewSchema } from '../../../../../../../shared/pilots';
import { getPilotView, pilotServices } from '../../../../../../services/pilots';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read a pilot',
		description: 'Shows one pilot with its baseline, success criteria, sites and decision.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		response: pilotViewSchema
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return getPilotView(pilotServices(), orgId, params.id);
	}
);
