import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { ssoViewSchema } from '../../../../../../shared/sso';
import { getSso, ssoServices } from '../../../../../services/sso';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'org.sso.manage',
		rateClass: 'read',
		tags: ['orgs'],
		summary: 'Read organisation sign-in',
		description:
			'Shows how people at the organisation sign in through its own identity provider: the provider address, the client id, the allowed email domains, the role mapping and whether it is on. The client secret never comes back; the answer only says whether one is stored.',
		params: z.object({ orgId: z.string().min(1) }),
		response: ssoViewSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return getSso(ssoServices(), orgId);
	}
);
