import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { ssoConfigBodySchema, ssoViewSchema } from '../../../../../../shared/sso';
import { configureSso, ssoServices } from '../../../../../services/sso';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.sso.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Set up organisation sign-in',
		description:
			'Saves the identity provider settings for the organisation. Leave the client secret out to keep the stored one. Turning sign-in on needs a passing test of the saved settings, and mails the organisation owners. A sign-in claim can map to viewer, developer, billing or admin and never to owner.',
		params: z.object({ orgId: z.string().min(1) }),
		body: ssoConfigBodySchema,
		response: ssoViewSchema
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const actorId = principal.kind === 'user' ? principal.userId : principal.issuerId;
		return configureSso(ssoServices(), { orgId, actorId, body });
	}
);
