import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { observationBodySchema, observationViewSchema } from '../../../../../../../shared/pilots';
import { addObservation, pilotServices } from '../../../../../../services/pilots';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Record an observation',
		description:
			'Adds an exception, failure, unsupported item, manual task or note to the pilot. Failures and unsupported items stay in the report.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		body: observationBodySchema,
		response: observationViewSchema
	},
	async ({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const row = await addObservation(pilotServices(), orgId, params.id, body);
		return {
			id: row.id,
			at: new Date(row.at).toISOString(),
			kind: row.kind,
			minutes: row.minutes,
			text: row.text
		};
	}
);
