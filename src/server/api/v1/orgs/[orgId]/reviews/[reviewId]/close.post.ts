import { z } from 'zod';
import { closeResultSchema } from '../../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../../shared/errors';
import { closeReview } from '../../../../../../services/access-reviews';
import { governanceActor, governanceServices } from '../../../../../../services/governance';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'review.manage',
		rateClass: 'write',
		tags: ['access-reviews'],
		summary: 'Close an access review',
		description:
			'Carries out every removal still waiting and closes the review. Every item needs a decision first. A removal that fails is recorded on its item and the review still closes.',
		params: z.object({ orgId: z.string().min(1), reviewId: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: closeResultSchema
	},
	({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return closeReview(
			governanceServices(),
			orgId,
			governanceActor(principal, facts),
			params.reviewId
		);
	}
);
