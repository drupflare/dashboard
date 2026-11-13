import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { proofBodySchema, proofViewSchema } from '../../../../../../../shared/estate-view';
import { startProof } from '../../../../../../services/estate';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.manage',
		rateClass: 'write',
		tags: ['assessments'],
		summary: 'Get the record that proves a domain',
		description:
			'Returns the TXT record and the file text that prove the organisation controls a domain. The value belongs to this organisation and this domain, and is not a site record. A domain with a proof on file comes back with proven set.',
		params: z.object({ orgId: z.string().min(1) }),
		body: proofBodySchema,
		response: proofViewSchema
	},
	({ resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return startProof(siteServices(), { orgId, domain: body.domain });
	}
);
