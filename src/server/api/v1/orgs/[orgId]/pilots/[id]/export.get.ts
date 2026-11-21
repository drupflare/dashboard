import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { pilotReportCsv, pilotServices } from '../../../../../../services/pilots';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'pilot.read',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Download the pilot observations as CSV',
		description:
			'Streams every observation of the pilot as CSV, in the order recorded. Text cells that start with a formula character are prefixed with an apostrophe.',
		params: z.object({ orgId: z.string().min(1), id: z.string().min(1) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const csv = await pilotReportCsv(pilotServices(), orgId, params.id);
		return new Response(csv, {
			status: 200,
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="pilot-${params.id}.csv"`
			}
		});
	}
);
