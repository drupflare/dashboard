import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { pilotPatchSchema, pilotViewSchema } from '../../../../../../../shared/pilots';
import { editPilot, pilotServices } from '../../../../../../services/pilots';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Change a pilot',
		description:
			'Changes the fields sent. A field left out keeps its stored value. A decided pilot keeps its start date.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		body: pilotPatchSchema,
		response: pilotViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return editPilot(pilotServices(), orgId, params.id, body);
	}
);
