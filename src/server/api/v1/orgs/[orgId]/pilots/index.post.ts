import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { pilotBodySchema, pilotViewSchema } from '../../../../../../shared/pilots';
import { createPilot, pilotServices } from '../../../../../services/pilots';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Create a pilot',
		description:
			'Starts a pilot with its baseline. The success criteria are the words the owner writes; nothing is filled in for them.',
		params: z.object({ orgId: z.string().min(1) }),
		body: pilotBodySchema,
		response: pilotViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createPilot(pilotServices(), orgId, body);
	}
);
