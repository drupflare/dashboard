import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { ASSESSMENT_ID, assessmentViewSchema } from '../../../../../../../shared/estate-view';
import { readAssessment } from '../../../../../../services/estate';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.read',
		rateClass: 'read',
		tags: ['assessments'],
		summary: 'Read an assessment',
		description:
			'Returns one assessment with its state, the number of rows in each state and class, and the report once it has finished.',
		params: z.object({ orgId: z.string().min(1), id: z.string().regex(ASSESSMENT_ID) }),
		response: assessmentViewSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return readAssessment(siteServices(), orgId, params.id);
	}
);
