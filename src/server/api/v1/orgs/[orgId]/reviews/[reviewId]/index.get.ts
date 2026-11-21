import { z } from 'zod';
import { reviewDetailSchema } from '../../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../../shared/errors';
import { reviewDetail } from '../../../../../../services/access-reviews';
import { governanceActor, governanceServices } from '../../../../../../services/governance';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.read',
		rateClass: 'read',
		tags: ['access-reviews'],
		summary: 'Read an access review',
		description:
			'Returns one review with the items, the decision on each and whether it is about you. Owners and admins see every item. A department admin sees only the items they can decide in their own departments, and the review is limited to those. Nobody can decide an item about themselves.',
		params: z.object({ orgId: z.string().min(1), reviewId: z.string().min(1).max(64) }),
		response: reviewDetailSchema
	},
	({ principal, resource, params, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const actor = governanceActor(principal, facts);
		return reviewDetail(governanceServices(), orgId, actor.userId, params.reviewId, actor);
	}
);
