import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { ASSESSMENT_ID } from '../../../../../../../shared/estate-view';
import { exportCsv } from '../../../../../../services/estate';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.read',
		rateClass: 'read',
		tags: ['assessments'],
		summary: 'Download an assessment as CSV',
		description:
			'Streams every row of the assessment as one CSV file. The inventory columns come first, so the file can be uploaded again as an inventory. Effort is written as Not estimated.',
		params: z.object({ orgId: z.string().min(1), id: z.string().regex(ASSESSMENT_ID) })
	},
	async ({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const csv = await exportCsv(siteServices(), { orgId, id: params.id });
		return new Response(csv, {
			status: 200,
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="${params.id}.csv"`
			}
		});
	}
);
