import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { assessmentViewSchema, createBodySchema } from '../../../../../../shared/estate-view';
import { startAssessment } from '../../../../../services/estate';
import { principalActor } from '../../../../../services/owner-tokens';
import { siteServices } from '../../../../../services/sites';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'assessment.manage',
		rateClass: 'heavy',
		tags: ['assessments'],
		summary: 'Assess an estate',
		description:
			'Reads an inventory of sites, given as CSV with a header row or as JSON, and starts one read-only check for every site it names. Rows that cannot be read are counted and left out; a file that cannot be read at all is refused. A site is checked from the outside with the same public check as the preflight. Sites on a server whose key is listed in credentialIds are also surveyed over SSH, read only. Only a few sites on a domain whose ownership is not proven are checked. Send an Idempotency-Key header; a repeat returns the same assessment.',
		params: z.object({ orgId: z.string().min(1) }),
		body: createBodySchema,
		response: assessmentViewSchema,
		successStatus: 202
	},
	async ({ principal, resource, params, body, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		if (idempotencyKey === undefined) {
			throw new ApiError('validation', 'The Idempotency-Key header is required');
		}
		return startAssessment(siteServices(), {
			orgId,
			userId: principal.kind === 'user' ? principal.userId : principal.issuerId,
			actor: principalActor(principal),
			text: body.text,
			credentialIds: body.credentialIds ?? [],
			idempotencyKey
		});
	}
);
