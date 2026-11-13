import { z } from 'zod';
import { keyCreateBodySchema, keyCreatedSchema } from '../../../../../../shared/api-keys';
import { ApiError } from '../../../../../../shared/errors';
import { issueKey, keyServices } from '../../../../../services/key-admin';
import type { UserPrincipal } from '../../../../../utils/auth';
import { defineApi } from '../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'key.create',
		rateClass: 'write',
		tags: ['api-keys'],
		summary: 'Create an API key',
		description:
			'Creates a key for the organisation in the path and returns its token once. The key can hold only permissions that you hold yourself and that a key can carry, and it loses any permission you lose. It needs a signed-in session with a fresh sign-in, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1) }),
		body: keyCreateBodySchema,
		response: keyCreatedSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, facts, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (principal === null || facts === null || orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		// a stored reply would keep the token at rest
		if (idempotencyKey !== undefined) {
			throw new ApiError(
				'validation',
				'This request does not take an Idempotency-Key header'
			);
		}
		return issueKey(keyServices(), {
			orgId,
			userId: (principal as UserPrincipal).userId,
			principal,
			facts,
			body
		});
	}
);
