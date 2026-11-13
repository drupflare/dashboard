import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { proofCheckBodySchema, proofCheckSchema } from '../../../../../../../shared/estate-view';
import { checkProof } from '../../../../../../services/estate';
import { principalActor } from '../../../../../../services/owner-tokens';
import { siteServices } from '../../../../../../services/sites';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.manage',
		rateClass: 'heavy',
		tags: ['assessments'],
		summary: 'Check a domain proof',
		description:
			'Looks for the proof of a domain, in DNS or in the file on the site, and records the domain as proven for the organisation when it finds it. The file is read from the domain over https through the public address guard.',
		params: z.object({ orgId: z.string().min(1) }),
		body: proofCheckBodySchema,
		response: proofCheckSchema
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return checkProof(siteServices(), {
			orgId,
			actor: principalActor(principal),
			domain: body.domain,
			method: body.method
		});
	}
);
