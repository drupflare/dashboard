import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { ssoTestResultSchema } from '../../../../../../shared/sso';
import { ssoServices, testSso } from '../../../../../services/sso';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.sso.manage',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Test organisation sign-in',
		description:
			'Reads the identity provider discovery document and one key set with the saved settings. Nobody signs in. A pass is recorded and allows turning sign-in on.',
		params: z.object({ orgId: z.string().min(1) }),
		response: ssoTestResultSchema
	},
	({ principal, resource, params }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		const actorId = principal.kind === 'user' ? principal.userId : principal.issuerId;
		return testSso(ssoServices(), { orgId, actorId });
	}
);
