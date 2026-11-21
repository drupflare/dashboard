import { z } from 'zod';
import { keyCreateBodySchema, keyCreatedSchema } from '../../../../../../../../shared/api-keys';
import { ApiError } from '../../../../../../../../shared/errors';
import { governanceActor, governanceServices } from '../../../../../../../services/governance';
import { issueAccountKey } from '../../../../../../../services/service-accounts';
import { defineApi } from '../../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'key.create',
		rateClass: 'write',
		tags: ['service-accounts'],
		summary: 'Create a key for a service account',
		description:
			'Creates a key for the service account and returns its token once. The key can hold only permissions that the account owner holds, it loses any permission the owner loses, and it never outlives the account. It needs a signed-in session with a fresh sign-in, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1), saId: z.string().min(1).max(64) }),
		body: keyCreateBodySchema,
		response: keyCreatedSchema,
		successStatus: 201
	},
	({ principal, resource, params, body, facts, idempotencyKey }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		// a stored reply would keep the token at rest
		if (idempotencyKey !== undefined) {
			throw new ApiError(
				'validation',
				'This request does not take an Idempotency-Key header'
			);
		}
		return issueAccountKey(
			governanceServices(),
			orgId,
			governanceActor(principal, facts),
			params.saId,
			body
		);
	}
);
