import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { pilotReport, pilotServices } from '../../../../../../services/pilots';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read the pilot report',
		description:
			'Assembles the report: what the old hosting cost, what Drupflare cost where a figure exists, the manual work and its minutes, failures, unsupported items and exceptions. Negative results are included.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) }),
		response: z.custom<Awaited<ReturnType<typeof pilotReport>>>()
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return pilotReport(pilotServices(), orgId, params.id);
	}
);
