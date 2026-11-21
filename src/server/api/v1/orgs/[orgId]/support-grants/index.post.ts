import { z } from 'zod';
import { ApiError } from '../../../../../../shared/errors';
import { supportGrantBody, supportGrantView } from '../../../../../../shared/support';
import { createGrant, supportServices } from '../../../../../services/support';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'support-grant.create',
		rateClass: 'write',
		tags: ['orgs'],
		summary: 'Let support into the organization',
		description:
			'Gives Drupflare support time-boxed access to this organization, for 1 hour up to 7 days. Needs step-up. Support never reads site content. Every use shows in your audit log, and you can revoke the grant at any time.',
		params: z.object({ orgId: z.string().min(1) }),
		body: supportGrantBody,
		response: supportGrantView,
		successStatus: 201
	},
	({ principal, resource, params, body }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId)
			throw new ApiError('not_found', 'Not found');
		if (principal === null) throw new Error('an organization route always has a principal');
		return createGrant(supportServices(), { orgId, principal, ...body });
	}
);
