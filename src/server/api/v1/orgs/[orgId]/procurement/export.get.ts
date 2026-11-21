import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { procurementCsv, procurementServices } from '../../../../../services/procurement';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'procurement.read',
		rateClass: 'read',
		tags: ['procurement'],
		summary: 'Download the procurement records as CSV',
		description:
			'Streams every procurement record of the organisation as CSV. Text cells that start with a formula character are prefixed with an apostrophe.',
		params: z.object({ orgId: z.string().min(1) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const csv = await procurementCsv(procurementServices(), orgId);
		return new Response(csv, {
			status: 200,
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': 'attachment; filename="procurement-records.csv"'
			}
		});
	}
);
