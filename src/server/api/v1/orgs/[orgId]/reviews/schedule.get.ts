import { z } from 'zod';
import { reviewScheduleViewSchema } from '../../../../../../shared/access-reviews';
import { ApiError } from '../../../../../../shared/errors';
import { getReviewSchedule } from '../../../../../services/access-reviews';
import { governanceServices } from '../../../../../services/governance';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'review.read',
		rateClass: 'read',
		tags: ['access-reviews'],
		summary: 'Read the review schedule',
		description:
			'Shows how often a review opens by itself: every quarter, every year or never, and when the last one opened.',
		params: z.object({ orgId: z.string().min(1) }),
		response: reviewScheduleViewSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return getReviewSchedule(governanceServices(), orgId);
	}
);
