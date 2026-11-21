import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { pilotViewSchema } from '../../../../../../shared/pilots';
import { listPilotViews, pilotServices } from '../../../../../services/pilots';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'List the pilots of an organisation',
		description:
			'Lists the pilots of the organisation, oldest first, with their assigned sites.',
		params: z.object({ orgId: z.string().min(1) }),
		response: z.object({ items: z.array(pilotViewSchema) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return { items: await listPilotViews(pilotServices(), orgId) };
	}
);
