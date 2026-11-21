import { z } from 'zod';
import { evidenceJsonSchema } from '../../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../../shared/errors';
import { reviewEvidence } from '../../../../../../services/access-reviews';
import { governanceServices } from '../../../../../../services/governance';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'review.read',
		rateClass: 'read',
		tags: ['access-reviews'],
		summary: 'Export the evidence of a closed review',
		description:
			'Returns a closed review as JSON, or as CSV with format=csv. Both carry the SHA-256 of the CSV, so a copy can be checked later. Text cells that start with a formula character are prefixed with an apostrophe.',
		params: z.object({ orgId: z.string().min(1), reviewId: z.string().min(1).max(64) }),
		query: z.object({ format: z.enum(['json', 'csv']).optional() }),
		response: evidenceJsonSchema
	},
	async ({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const { json, csv } = await reviewEvidence(governanceServices(), orgId, params.reviewId);
		if (query.format !== 'csv') return json;
		return new Response(csv, {
			status: 200,
			headers: {
				'Content-Type': 'text/csv; charset=utf-8',
				'Content-Disposition': `attachment; filename="access-review-${params.reviewId}.csv"`,
				'X-Content-Sha256': json.sha256
			}
		});
	}
);
