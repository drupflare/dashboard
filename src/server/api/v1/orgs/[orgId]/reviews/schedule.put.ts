import { z } from 'zod';
import {
	reviewScheduleBodySchema,
	reviewScheduleViewSchema
} from '../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../shared/errors';
import { setReviewSchedule } from '../../../../../services/access-reviews';
import { governanceActor, governanceServices } from '../../../../../services/governance';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'review.manage',
		rateClass: 'write',
		tags: ['access-reviews'],
		summary: 'Set the review schedule',
		description:
			'Sets how often a review of the whole organization opens by itself. The first one opens after a full interval has passed.',
		params: z.object({ orgId: z.string().min(1) }),
		body: reviewScheduleBodySchema,
		response: reviewScheduleViewSchema
	},
	({ principal, resource, params, body, facts }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return setReviewSchedule(
			governanceServices(),
			orgId,
			governanceActor(principal, facts),
			body.interval
		);
	}
);
