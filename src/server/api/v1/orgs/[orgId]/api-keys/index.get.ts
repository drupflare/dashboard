import { z } from 'zod';
import { keyPageSchema } from '../../../../../../shared/api-keys';
import { ApiError } from '../../../../../../shared/errors';
import { keyServices, listKeys } from '../../../../../services/key-admin';
import { defineApi } from '../../../../../utils/define-api';
import { decodeCursor, resolveLimit } from '../../../../../utils/pagination';

const cursorShape = z.object({ createdAt: z.number(), id: z.string().min(1) });

export default defineApi(
	{
		scope: 'organization',
		action: 'key.read',
		rateClass: 'read',
		tags: ['api-keys'],
		summary: 'List API keys',
		description:
			'Lists the API keys of the organisation in the path, newest first: the name, the public prefix, the permissions, and when each was created, last used and expires or was revoked. The secret is shown once, when the key is created, and never again.',
		params: z.object({ orgId: z.string().min(1) }),
		query: z.object({
			cursor: z.string().optional(),
			limit: z.string().regex(/^\d+$/).optional()
		}),
		response: keyPageSchema
	},
	({ resource, params, query }) => {
		const orgId = resource.orgId;
		if (orgId === undefined || orgId !== params.orgId) {
			throw new ApiError('not_found', 'Not found');
		}
		return listKeys(keyServices(), orgId, {
			after: query.cursor === undefined ? undefined : decodeCursor(query.cursor, cursorShape),
			limit: resolveLimit(query.limit === undefined ? undefined : Number(query.limit))
		});
	}
);
