import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { ASSESSMENT_ID, assessmentViewSchema } from '../../../../../../../shared/estate-view';
import { cancelEstate } from '../../../../../../services/estate';
import { principalActor } from '../../../../../../services/owner-tokens';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.manage',
		rateClass: 'write',
		tags: ['assessments'],
		summary: 'Cancel an assessment',
		description:
			'Stops an assessment that is still running. Sites already checked keep their results, and the rest are marked skipped. An assessment that has finished cannot be cancelled.',
		params: z.object({ orgId: z.string().min(1), id: z.string().regex(ASSESSMENT_ID) }),
		response: assessmentViewSchema
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return cancelEstate(siteServices(), {
			orgId,
			id: params.id,
			actor: principalActor(principal)
		});
	}
);
