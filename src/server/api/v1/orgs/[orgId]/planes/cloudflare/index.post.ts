import { z } from 'zod';
import { ApiError } from '../../../../../../../shared/errors';
import { connectResultSchema } from '../../../../../../../shared/plane-connections';
import {
	connectCloudflare,
	planeConnectionDeps
} from '../../../../../../services/plane-connections';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'plane.connect',
		rateClass: 'heavy',
		tags: ['planes'],
		summary: 'Connect a Cloudflare account',
		description:
			'Checks the token, and stores one only if it can edit Workers scripts. When the token can make other tokens, Drupflare makes a narrower one for this account, keeps only that, and does not keep the one you gave. Otherwise it keeps the token you gave. The stored token is sealed and never returned. It needs a signed-in session, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1) }),
		body: z.strictObject({
			token: z.string().min(1).max(512),
			accountId: z.string().min(1).max(64).optional()
		}),
		response: connectResultSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		// a stored reply would keep the response, and the request body holds a token
		if (idempotencyKey !== undefined) {
			throw new ApiError(
				'validation',
				'This request does not take an Idempotency-Key header'
			);
		}
		return connectCloudflare(planeConnectionDeps(), { orgId, ...body });
	}
);
