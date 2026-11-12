import { z } from 'zod';
import { probeReportSchema } from '../../../../../../../shared/cloudflare-probe';
import { ApiError } from '../../../../../../../shared/errors';
import { probeCloudflareToken } from '../../../../../../integrations/cloudflare-probe';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'plane.connect',
		rateClass: 'heavy',
		tags: ['planes'],
		summary: 'Check what a Cloudflare token can do',
		description:
			'Reads what the token can see and do on the account it names. Nothing is stored and the token is not returned. It needs a signed-in session, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			token: z.string().min(1).max(512),
			accountId: z.string().min(1).max(64).optional()
		}),
		response: probeReportSchema
	},
	async ({ principal, resource, params, body }) => {
		if (principal === null || resource.orgId === undefined || resource.orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return probeCloudflareToken({
			token: body.token,
			accountId: body.accountId,
			fetch: (input, init) => fetch(input, init)
		});
	}
);
