import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { decisionBodySchema, pilotViewSchema } from '../../../../../../../shared/pilots';
import { pilotServices, recordDecision } from '../../../../../../services/pilots';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Record the decision on a pilot',
		description:
			'Records whether the organisation continues, extends or stops, and what it would pay to continue. A stop is recorded the same way as a continue.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		body: decisionBodySchema,
		response: pilotViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return recordDecision(pilotServices(), orgId, params.id, body);
	}
);
