import { z } from 'zod';
import { keyViewSchema } from '../../../../../../../shared/api-keys';
import { ApiError } from '../../../../../../../shared/errors';
import { keyServices, revokeKey } from '../../../../../../services/key-admin';
import { defineApi } from '../../../../../../utils/define-api';

export default defineApi(
	{
		scope: 'organization',
		action: 'key.revoke',
		rateClass: 'write',
		tags: ['api-keys'],
		summary: 'Revoke an API key',
		description:
			'Stops a key from working at once. The next request that carries it is refused. Revoking a key that is already revoked changes nothing. It needs a signed-in session, so an API key is refused.',
		params: z.object({ orgId: z.string().min(1), keyId: z.string().min(1).max(64) }),
		body: z.strictObject({}),
		response: keyViewSchema
	},
	({ resource, params }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return revokeKey(keyServices(), orgId, params.keyId);
	}
);
