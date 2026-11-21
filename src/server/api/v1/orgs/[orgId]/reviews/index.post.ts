import { z } from 'zod';
import { reviewCreateBodySchema, reviewViewSchema } from '../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../shared/errors';
import { createReview } from '../../../../../services/access-reviews';
import { governanceActor, governanceServices } from '../../../../../services/governance';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'review.manage',
		rateClass: 'write',
		tags: ['access-reviews'],
		summary: 'Open an access review',
		description:
			'Opens a review of the whole organization or of one department and its sub-departments. It takes a copy of the people, grants, agency access, keys and service accounts in scope as they are now. Changes made later do not alter the copy.',
		params: z.object({ orgId: z.string().min(1) }),
		body: reviewCreateBodySchema,
		response: reviewViewSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return createReview(governanceServices(), orgId, governanceActor(principal, facts), body);
	}
);
